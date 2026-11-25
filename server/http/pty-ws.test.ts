import http from 'node:http';
import { connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyManager, type PtyProcess } from '../pty/manager';
import { setQuiet } from '../log';
import { acceptKey, encodeFrame, WsFrameDecoder, createPtyWsUpgrade } from './pty-ws';

setQuiet(true);

// ---------------------------------------------------------------- frames do cliente (sempre mascarados)

/** Monta um frame cliente → servidor (mascarado, como o navegador manda). */
function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

const textFrame = (s: string, fin = true, opcode = 0x1): Buffer => clientFrame(opcode, Buffer.from(s, 'utf8'), fin);

describe('WsFrameDecoder', () => {
  it('decodifica uma mensagem de texto mascarada', () => {
    const d = new WsFrameDecoder();
    expect(d.push(textFrame('hello'))).toEqual([{ type: 'message', data: 'hello' }]);
  });

  it('separa várias mensagens que chegam num mesmo chunk, na ordem', () => {
    const d = new WsFrameDecoder();
    const chunk = Buffer.concat([textFrame('a'), textFrame('b'), textFrame('c')]);
    expect(d.push(chunk)).toEqual([
      { type: 'message', data: 'a' },
      { type: 'message', data: 'b' },
      { type: 'message', data: 'c' },
    ]);
  });

  it('remonta uma mensagem partida entre dois chunks (fronteira preservada)', () => {
    const d = new WsFrameDecoder();
    const frame = textFrame('espaço  '); // mantém os espaços
    const a = frame.subarray(0, 4);
    const b = frame.subarray(4);
    expect(d.push(a)).toEqual([]);
    expect(d.push(b)).toEqual([{ type: 'message', data: 'espaço  ' }]);
  });

  it('junta frames fragmentados (FIN=0 + continuação) numa só mensagem', () => {
    const d = new WsFrameDecoder();
    const start = textFrame('ab', false, 0x1); // text, FIN=0
    const cont = textFrame('cd', true, 0x0); // continuation, FIN=1
    expect(d.push(start)).toEqual([]);
    expect(d.push(cont)).toEqual([{ type: 'message', data: 'abcd' }]);
  });

  it('entende ping e close', () => {
    const d = new WsFrameDecoder();
    expect(d.push(clientFrame(0x9, Buffer.from('pp')))).toEqual([{ type: 'ping', data: Buffer.from('pp') }]);
    const close = Buffer.alloc(2);
    close.writeUInt16BE(1000, 0);
    expect(d.push(clientFrame(0x8, close))).toEqual([{ type: 'close', code: 1000 }]);
  });

  it('falha (e para) em frame de cliente sem máscara', () => {
    const d = new WsFrameDecoder();
    const unmasked = Buffer.from([0x81, 0x01, 0x61]); // text, FIN, len 1, SEM bit de máscara
    const events = d.push(unmasked);
    expect(events[0].type).toBe('error');
    // Depois de falhar, ignora tudo.
    expect(d.push(textFrame('x'))).toEqual([]);
  });

  it('falha em mensagem acima do limite', () => {
    const d = new WsFrameDecoder(8);
    const events = d.push(textFrame('0123456789'));
    expect(events[0].type).toBe('error');
  });
});

describe('acceptKey', () => {
  it('calcula a Sec-WebSocket-Accept do exemplo da RFC 6455', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

describe('encodeFrame', () => {
  it('monta um frame de servidor sem máscara', () => {
    const f = encodeFrame(0x1, Buffer.from('hi'));
    expect(f[0]).toBe(0x81); // FIN + text
    expect(f[1]).toBe(2); // len 2, sem bit de máscara
    expect(f.subarray(2).toString()).toBe('hi');
  });
});

// ---------------------------------------------------------------- integração (upgrade + ordem + auth)

class FakeProc implements PtyProcess {
  written: string[] = [];
  private onExitCb: (e: { exitCode: number }) => void = () => {};
  constructor(readonly pid: number) {}
  onData() {}
  onExit(cb: (e: { exitCode: number }) => void) {
    this.onExitCb = cb;
  }
  write(d: string) {
    this.written.push(d);
  }
  resize() {}
  kill() {
    this.onExitCb({ exitCode: 0 });
  }
}

interface Env {
  server: http.Server;
  port: number;
  proc: FakeProc;
  ptyId: string;
  dir: string;
  closeAll: () => void;
}

async function startServer(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'ptyws-'));
  let proc: FakeProc | undefined;
  const manager = new PtyManager({
    spawn: () => {
      proc = new FakeProc(4242);
      return proc;
    },
    claudeBin: process.execPath, // existe e é executável: passa na checagem do plan()
    accounts: () => [{ id: 'acc', dir: join(dir, 'conta'), isDefault: true }],
    agent: () => undefined,
    onChange: () => {},
  });
  const info = manager.create({ cwd: dir, cols: 80, rows: 24 });
  const ptyWs = createPtyWsUpgrade(manager);
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', ptyWs.upgrade);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  return { server, port, proc: proc!, ptyId: info.id, dir, closeAll: ptyWs.closeAll };
}

/** Abre o socket, faz o handshake e devolve {socket, status}. status 101 = virou WebSocket. */
function handshake(port: number, path: string, headers: Record<string, string>): Promise<{ socket: Socket; status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${headers.Host ?? `localhost:${port}`}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
      ];
      for (const [k, v] of Object.entries(headers)) if (k !== 'Host') lines.push(`${k}: ${v}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      socket.off('data', onData);
      const raw = buf.subarray(0, sep).toString('utf8');
      const status = Number(/HTTP\/1\.1 (\d+)/.exec(raw)?.[1] ?? 0);
      resolve({ socket, status, raw });
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

describe('createPtyWsUpgrade (integração)', () => {
  let env: Env;
  beforeEach(async () => {
    env = await startServer();
  });
  afterEach(() => {
    env.closeAll();
    env.server.close();
    rmSync(env.dir, { recursive: true, force: true });
  });

  it('aceita o upgrade e escreve cada mensagem no pty, separada e na ordem', async () => {
    const { socket, status } = await handshake(env.port, `/api/pty/${env.ptyId}/ws`, {});
    expect(status).toBe(101);
    // 30 teclas, uma mensagem por tecla (simula o auto-repeat da barra de espaço).
    const keys = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? ' ' : String.fromCharCode(97 + (i % 26))));
    for (const k of keys) socket.write(textFrame(k));
    await new Promise((ok) => setTimeout(ok, 100));
    expect(env.proc.written).toEqual(keys);
    socket.destroy();
  });

  it('preserva a mensagem mesmo quando várias teclas chegam num único pacote TCP', async () => {
    const { socket } = await handshake(env.port, `/api/pty/${env.ptyId}/ws`, {});
    socket.write(Buffer.concat([textFrame('a'), textFrame('b'), textFrame('c')]));
    await new Promise((ok) => setTimeout(ok, 100));
    expect(env.proc.written).toEqual(['a', 'b', 'c']);
    socket.destroy();
  });

  it('recusa (403) quando o Origin é de outra origem', async () => {
    const { socket, status } = await handshake(env.port, `/api/pty/${env.ptyId}/ws`, { Origin: 'http://evil.example' });
    expect(status).toBe(403);
    socket.destroy();
  });

  it('recusa (403) quando o Host não é local', async () => {
    const { socket, status } = await handshake(env.port, `/api/pty/${env.ptyId}/ws`, { Host: 'evil.example' });
    expect(status).toBe(403);
    socket.destroy();
  });

  it('ignora upgrades fora da rota /api/pty/:id/ws (deixa para outro listener)', async () => {
    // Sem outro listener, o socket fica sem resposta: a conexão não recebe 101 nem erro.
    const result = await Promise.race([
      handshake(env.port, '/outra/rota', {}).then((r) => {
        r.socket.destroy();
        return 'responded';
      }),
      new Promise<string>((ok) => setTimeout(() => ok('ignored'), 200)),
    ]);
    expect(result).toBe('ignored');
  });
});
