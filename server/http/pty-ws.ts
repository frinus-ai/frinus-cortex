// Canal de ENTRADA de baixa latência do terminal interativo: um WebSocket (RFC 6455) feito só com os módulos
// embutidos do Node (sem dependência de runtime — ver README). A saída continua pelo SSE de GET /api/pty/:id/stream
// (http/pty.ts); aqui só entram as teclas.
//
// Por quê: o cliente antigo juntava as teclas numa fila de POST /input encadeada (ui/ptypane.ts). Enquanto um POST
// estava em voo, as teclas seguintes se acumulavam e iam juntas — cada eco pagava um round trip em série (pior em
// máquina carregada / WSL) e, pior, o auto-repeat da barra de espaço chegava coalescido ("     " de uma vez), e o
// Claude Code não reconhecia isso como tecla segurada (o /voice em modo hold só abria depois de soltar). Aqui cada
// term.onData vira UMA mensagem, na ordem, e o servidor faz proc.write por mensagem.
//
// Segurança: o WebSocket é upgrade de GET, então o guard de requisição (http/guard.ts) NÃO roda sobre ele. Repetimos
// aqui exatamente a mesma checagem das rotas /api/pty (ptyRequestProblem: só loopback, Host local, Origin de mesma
// origem e sem sec-fetch-site de outro site). Só o servidor principal (local) sobe isto: o terminal já recusa
// qualquer conexão que não seja do próprio computador, então a porta remota (http/remote.ts) nunca o serve.
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { PtyError, type PtyManager } from '../pty/manager';
import { ptyRequestProblem } from './pty';
import { errMsg, log } from '../log';
import { tr } from '../../shared/i18n';

/** Mágico do handshake do WebSocket (RFC 6455, seção 1.3). */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** /api/pty/:id/ws (ids nunca contêm '/'). */
const WS_ROUTE = /^\/api\/pty\/([^/]+)\/ws$/;
/** Teto por mensagem: acima disto a conexão é fechada (input() do manager ainda recusa acima de 64 KB). */
const MAX_MESSAGE_BYTES = 256 * 1024;

// ---------------------------------------------------------------- frames (RFC 6455)

export interface WsMessageEvent {
  type: 'message';
  data: string;
}
export interface WsPingEvent {
  type: 'ping';
  data: Buffer;
}
export interface WsPongEvent {
  type: 'pong';
  data: Buffer;
}
export interface WsCloseEvent {
  type: 'close';
  code?: number;
}
export interface WsErrorEvent {
  type: 'error';
  code: number;
  reason: string;
}
export type WsEvent = WsMessageEvent | WsPingEvent | WsPongEvent | WsCloseEvent | WsErrorEvent;

/**
 * Decodifica o fluxo de bytes de um WebSocket (lado cliente → servidor: todo frame é mascarado). Acumula o que
 * chega e devolve um evento por frame completo, preservando fronteiras e ordem; frames fragmentados (FIN=0 +
 * continuações) viram uma única mensagem. Ao detectar violação de protocolo, marca falha e devolve um evento
 * `error` (o chamador fecha a conexão); daí em diante ignora tudo.
 */
export class WsFrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private inFragment = false;
  private failed = false;

  constructor(private readonly maxMessageBytes = MAX_MESSAGE_BYTES) {}

  push(chunk: Buffer): WsEvent[] {
    if (this.failed || chunk.length === 0) return [];
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: WsEvent[] = [];
    for (;;) {
      const events = this.readFrame();
      if (events === null) break; // faltam bytes
      for (const ev of events) out.push(ev);
      if (this.failed) break;
    }
    return out;
  }

  /** Lê um frame do buffer: null = faltam bytes; [] = frame consumido sem evento (início de fragmento). */
  private readFrame(): WsEvent[] | null {
    const buf = this.buf;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (rsv !== 0) return this.fail(1002, 'RSV bits set');
    if (len === 126) {
      if (buf.length < off + 2) return null;
      len = buf.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (buf.length < off + 8) return null;
      const hi = buf.readUInt32BE(off);
      const lo = buf.readUInt32BE(off + 4);
      if (hi !== 0 || lo > this.maxMessageBytes) return this.fail(1009, 'frame too large');
      len = lo;
      off += 8;
    }
    if (!masked) return this.fail(1002, 'client frame not masked');
    if (len > this.maxMessageBytes) return this.fail(1009, 'frame too large');
    if (buf.length < off + 4 + len) return null; // máscara (4) + payload
    const mask = buf.subarray(off, off + 4);
    off += 4;
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = buf[off + i] ^ mask[i & 3];
    off += len;
    this.buf = buf.subarray(off);

    const isControl = (opcode & 0x08) !== 0;
    if (isControl) {
      if (!fin) return this.fail(1002, 'fragmented control frame');
      if (len > 125) return this.fail(1002, 'control frame too long');
      if (opcode === 0x8) return [{ type: 'close', code: len >= 2 ? payload.readUInt16BE(0) : undefined }];
      if (opcode === 0x9) return [{ type: 'ping', data: payload }];
      if (opcode === 0xa) return [{ type: 'pong', data: payload }];
      return this.fail(1002, `unknown control opcode ${opcode}`);
    }
    if (opcode === 0x0) {
      if (!this.inFragment) return this.fail(1002, 'continuation without start');
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > this.maxMessageBytes) return this.fail(1009, 'message too large');
      return fin ? [this.finishMessage()] : [];
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (this.inFragment) return this.fail(1002, 'new data frame during fragment');
      if (fin) return [{ type: 'message', data: payload.toString('utf8') }];
      this.inFragment = true;
      this.fragments = [payload];
      this.fragmentBytes = payload.length;
      if (this.fragmentBytes > this.maxMessageBytes) return this.fail(1009, 'message too large');
      return [];
    }
    return this.fail(1002, `unknown opcode ${opcode}`);
  }

  private finishMessage(): WsMessageEvent {
    const full = Buffer.concat(this.fragments, this.fragmentBytes);
    this.inFragment = false;
    this.fragments = [];
    this.fragmentBytes = 0;
    return { type: 'message', data: full.toString('utf8') };
  }

  private fail(code: number, reason: string): WsEvent[] {
    this.failed = true;
    this.buf = Buffer.alloc(0);
    return [{ type: 'error', code, reason }];
  }
}

/** Monta um frame servidor → cliente (nunca mascarado). */
export function encodeFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

export const encodePong = (payload: Buffer): Buffer => encodeFrame(0xa, payload);

export function encodeClose(code = 1000, reason = ''): Buffer {
  const r = Buffer.from(reason, 'utf8');
  const payload = Buffer.alloc(2 + r.length);
  payload.writeUInt16BE(code, 0);
  r.copy(payload, 2);
  return encodeFrame(0x8, payload);
}

/** Chave Sec-WebSocket-Accept a partir da Sec-WebSocket-Key do cliente (RFC 6455, seção 4.2.2). */
export function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
}

// ---------------------------------------------------------------- upgrade handler

export interface PtyWsUpgrade {
  /** Listener do evento `upgrade` do http.Server. Só trata /api/pty/:id/ws; o resto deixa para outros (HMR do Vite). */
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** Fecha todos os sockets abertos (no desligamento). */
  closeAll: () => void;
}

/**
 * Cria o handler de upgrade do WebSocket de entrada do terminal. Cada mensagem recebida vira um `ptys.input(id, msg)`
 * (um proc.write por mensagem, na ordem). Mantém o POST /input como antes — este canal é só um atalho de baixa
 * latência; se ele não abrir ou cair, o cliente volta ao POST.
 */
export function createPtyWsUpgrade(ptys: PtyManager): PtyWsUpgrade {
  const sockets = new Set<Socket>();

  const upgrade = (req: IncomingMessage, rawSocket: Duplex, head: Buffer): void => {
    const path = (req.url ?? '/').split('?')[0];
    const m = WS_ROUTE.exec(path);
    if (!m) return; // não é nosso: deixa o socket para outro listener (ex.: HMR do Vite no modo dev)
    const socket = rawSocket as Socket;
    try {
      handle(ptys, req, socket, head, m[1], sockets);
    } catch (err) {
      log.warn(tr('Erro no WebSocket do terminal: {0}', [errMsg(err)]));
      abort(socket, 500, tr('erro interno'));
    }
  };

  const closeAll = (): void => {
    for (const s of sockets) {
      try {
        s.write(encodeClose(1001, 'server shutdown'));
        s.destroy();
      } catch {
        // encerrando: nada a fazer
      }
    }
    sockets.clear();
  };

  return { upgrade, closeAll };
}

function handle(ptys: PtyManager, req: IncomingMessage, socket: Socket, head: Buffer, rawId: string, sockets: Set<Socket>): void {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  const upgradeHeader = (req.headers.upgrade ?? '').toLowerCase();
  if ((req.method ?? 'GET') !== 'GET' || upgradeHeader !== 'websocket' || typeof key !== 'string' || version !== '13') {
    return abort(socket, 400, tr('handshake de WebSocket inválido'));
  }
  // Mesma trava das rotas /api/pty (o guard de requisição não roda no upgrade).
  const problem = ptyRequestProblem(req);
  if (problem) return abort(socket, 403, problem);
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return abort(socket, 400, tr('id inválido'));
  }

  socket.setNoDelay?.(true); // frames pequenos sem Nagle: o eco não pode esperar
  socket.setTimeout?.(0);
  socket.write('HTTP/1.1 101 Switching Protocols\r\n' + 'Upgrade: websocket\r\n' + 'Connection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  sockets.add(socket);

  const decoder = new WsFrameDecoder();
  let closed = false;
  const closeWith = (code: number, reason = ''): void => {
    if (closed) return;
    closed = true;
    sockets.delete(socket);
    try {
      socket.write(encodeClose(code, reason));
    } catch {
      // socket já caiu
    }
    socket.end();
  };

  const onData = (chunk: Buffer): void => {
    if (closed) return;
    for (const ev of decoder.push(chunk)) {
      if (ev.type === 'message') {
        try {
          ptys.input(id, ev.data);
        } catch (err) {
          // Terminal encerrado/sumiu: fecha (o cliente também soube pelo SSE 'exit'). Entrada inválida: ignora a
          // mensagem e segue (não derruba a sessão por um frame ruim).
          if (err instanceof PtyError && (err.status === 404 || err.status === 409)) return closeWith(1000, 'pty gone');
          log.warnOnce(`pty-ws:input:${errMsg(err)}`, tr('Entrada do terminal recusada: {0}', [errMsg(err)]));
        }
      } else if (ev.type === 'ping') {
        try {
          socket.write(encodePong(ev.data));
        } catch {
          // socket já caiu
        }
      } else if (ev.type === 'close') {
        return closeWith(1000);
      } else if (ev.type === 'error') {
        return closeWith(ev.code, ev.reason);
      }
    }
  };

  socket.on('data', onData);
  socket.on('error', () => {
    closed = true;
    sockets.delete(socket);
    socket.destroy();
  });
  socket.on('close', () => {
    closed = true;
    sockets.delete(socket);
  });
  // Bytes que já vieram junto do handshake (raro, mas possível).
  if (head && head.length) onData(head);
}

/** Recusa o upgrade com uma resposta HTTP curta e fecha o socket (quando ainda não viramos WebSocket). */
function abort(socket: Duplex, status: number, message: string): void {
  const text: Record<number, string> = { 400: 'Bad Request', 403: 'Forbidden', 500: 'Internal Server Error' };
  const body = `${message}\n`;
  try {
    socket.write(`HTTP/1.1 ${status} ${text[status] ?? 'Error'}\r\n` + 'Content-Type: text/plain; charset=utf-8\r\n' + `Content-Length: ${Buffer.byteLength(body)}\r\n` + 'Connection: close\r\n\r\n' + body);
  } catch {
    // socket já caiu
  }
  socket.destroy();
}
