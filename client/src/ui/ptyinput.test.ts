import { describe, expect, it } from 'vitest';
import { PtyInput, type InputSocket } from './ptyinput';

const tick = (): Promise<void> => new Promise((ok) => setTimeout(ok, 0));

class FakeSocket implements InputSocket {
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closed = false;
  private listeners: Record<'open' | 'close' | 'error', (() => void)[]> = { open: [], close: [], error: [] };
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket não aberto');
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void {
    this.listeners[type].push(listener);
  }
  open(): void {
    this.readyState = 1;
    for (const cb of this.listeners.open) cb();
  }
  fail(): void {
    this.readyState = 3;
    for (const cb of this.listeners.error) cb();
  }
  drop(): void {
    this.readyState = 3;
    for (const cb of this.listeners.close) cb();
  }
}

/** Relógio manual: guarda os timers e deixa o teste disparar quando quiser. */
class Clock {
  private items = new Map<number, () => void>();
  private seq = 1;
  readonly set = (fn: () => void): ReturnType<typeof setTimeout> => {
    const id = this.seq++;
    this.items.set(id, fn);
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  readonly clear = (h: ReturnType<typeof setTimeout>): void => {
    this.items.delete(h as unknown as number);
  };
  runAll(): void {
    const fns = [...this.items.values()];
    this.items.clear();
    for (const fn of fns) fn();
  }
  get size(): number {
    return this.items.size;
  }
}

interface Harness {
  input: PtyInput;
  sockets: FakeSocket[];
  posts: string[];
  clock: Clock;
}

function make(): Harness {
  const sockets: FakeSocket[] = [];
  const posts: string[] = [];
  const clock = new Clock();
  const input = new PtyInput({
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    wsUrl: (id) => `ws://test/${id}`,
    post: (_url, body) => {
      posts.push((body as { data: string }).data);
      return Promise.resolve();
    },
    setTimer: clock.set,
    clearTimer: clock.clear,
  });
  return { input, sockets, posts, clock };
}

describe('PtyInput', () => {
  it('com o WebSocket aberto, manda cada tecla numa mensagem separada e na ordem (não coalesce)', async () => {
    const h = make();
    h.input.attach('p1');
    h.sockets[0].open();
    const keys = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? ' ' : 'x'));
    for (const k of keys) h.input.send(k);
    await tick();
    expect(h.sockets[0].sent).toEqual(keys);
    expect(h.posts).toEqual([]);
    expect(h.input.channel).toBe('ws');
  });

  it('bufferiza as teclas digitadas antes do open e as manda em ordem quando abre', async () => {
    const h = make();
    h.input.attach('p1');
    h.input.send('a');
    h.input.send('b');
    expect(h.input.channel).toBe('connecting');
    expect(h.sockets[0].sent).toEqual([]);
    h.sockets[0].open();
    await tick();
    expect(h.sockets[0].sent).toEqual(['a', 'b']);
  });

  it('cai para o POST se o WebSocket falha antes de abrir, sem perder teclas', async () => {
    const h = make();
    h.input.attach('p1');
    h.input.send('h');
    h.input.send('i');
    h.sockets[0].fail();
    await tick();
    expect(h.input.channel).toBe('post');
    expect(h.posts.join('')).toBe('hi');
  });

  it('usa o POST quando o WebSocket cai no meio e reassume o WebSocket depois de reconectar', async () => {
    const h = make();
    h.input.attach('p1');
    h.sockets[0].open();
    h.input.send('a');
    await tick();
    expect(h.sockets[0].sent).toEqual(['a']);
    // Cai: as teclas seguintes vão por POST.
    h.sockets[0].drop();
    h.input.send('b');
    await tick();
    expect(h.input.channel).toBe('post');
    expect(h.posts).toContain('b');
    // Reconecta (timer de reconexão) e reabre.
    h.clock.runAll();
    expect(h.sockets.length).toBe(2);
    h.sockets[1].open();
    await tick();
    // Com a fila do POST vazia, volta ao WebSocket.
    h.input.send('c');
    await tick();
    expect(h.sockets[1].sent).toEqual(['c']);
    expect(h.input.channel).toBe('ws');
  });

  it('cai para o POST quando o open demora além do tempo limite', async () => {
    const h = make();
    h.input.attach('p1');
    h.input.send('a'); // fica no buffer de conexão
    expect(h.input.channel).toBe('connecting');
    h.clock.runAll(); // dispara o connectTimer (e agenda a reconexão)
    await tick();
    expect(h.input.channel).toBe('post');
    expect(h.posts.join('')).toBe('a');
  });

  it('depois de close(), ignora novas teclas e não reconecta', async () => {
    const h = make();
    h.input.attach('p1');
    h.sockets[0].open();
    h.input.close();
    h.input.send('x');
    await tick();
    expect(h.sockets[0].sent).toEqual([]);
    expect(h.posts).toEqual([]);
  });
});
