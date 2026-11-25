// Canal de ENTRADA do terminal interativo. Cada tecla (term.onData em ui/ptypane.ts) é enviada na hora e separada —
// sem juntar as teclas numa fila como o POST /input fazia (o que atrasava o eco e quebrava o "segurar espaço" do
// /voice, que chegava como vários espaços colados). O caminho rápido é um WebSocket (server/http/pty-ws.ts): uma
// mensagem por tecla, na ordem. Se o WebSocket não abrir ou cair, volta ao POST /input (e tenta reabrir em segundo
// plano). A saída continua vindo pelo SSE (ui/ptypane.ts).
import { postPty } from './ptyapi';

const WS_OPEN = 1;

/** O mínimo que usamos de um WebSocket (injetável nos testes, que rodam sem DOM). */
export interface InputSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
}

export interface PtyInputDeps {
  /** Abre o socket de entrada (padrão: WebSocket do navegador). */
  openSocket?: (url: string) => InputSocket;
  /** URL do WebSocket de um pty (padrão: ws[s]://<host>/api/pty/<id>/ws). */
  wsUrl?: (id: string) => string;
  /** Envio de reserva por POST (padrão: postPty de ui/ptyapi.ts). */
  post?: (url: string, body: unknown) => Promise<unknown>;
  /** Espera (ms) antes de tentar reabrir o WebSocket depois de uma queda (padrão: 1000, com recuo até 10000). */
  reconnectDelayMs?: number;
  /** Quanto esperar (ms) o primeiro open antes de cair para o POST (padrão: 1500). */
  connectTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
}

type Mode = 'connecting' | 'ws' | 'post';

function defaultWsUrl(id: string): string {
  const loc = window.location;
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${loc.host}/api/pty/${encodeURIComponent(id)}/ws`;
}

export class PtyInput {
  private id: string | null = null;
  private ws: InputSocket | null = null;
  private mode: Mode = 'post';
  private closed = true;
  /** Teclas digitadas antes do primeiro open (modo inicial): mantêm a ordem, mandadas no open. */
  private preOpen: string[] = [];
  /** WebSocket reaberto após queda, esperando a fila do POST esvaziar para reassumir o envio. */
  private wantSwitch = false;
  /** Fila do POST (serial, preserva a ordem das teclas). */
  private pendingPost = '';
  private postBusy = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 0;

  private readonly openSocket: (url: string) => InputSocket;
  private readonly wsUrl: (id: string) => string;
  private readonly post: (url: string, body: unknown) => Promise<unknown>;
  private readonly baseReconnectMs: number;
  private readonly connectTimeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (h: ReturnType<typeof setTimeout>) => void;

  constructor(deps: PtyInputDeps = {}) {
    this.openSocket = deps.openSocket ?? ((url) => new WebSocket(url) as unknown as InputSocket);
    this.wsUrl = deps.wsUrl ?? defaultWsUrl;
    this.post = deps.post ?? ((url, body) => postPty(url, body));
    this.baseReconnectMs = deps.reconnectDelayMs ?? 1000;
    this.connectTimeoutMs = deps.connectTimeoutMs ?? 1500;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  }

  /** Canal em uso agora (diagnóstico/testes). */
  get channel(): Mode {
    return this.mode;
  }

  /** Liga a um pty do servidor (outro pty = conexão nova). */
  attach(id: string): void {
    this.close();
    this.id = id;
    this.closed = false;
    this.openWs(false);
  }

  /** Envia uma tecla (ou um trecho colado). Chamado uma vez por term.onData — nunca junta com o anterior. */
  send(data: string): void {
    if (this.closed || !this.id || !data) return;
    if (this.mode === 'ws') return this.wsSend(data);
    if (this.mode === 'connecting') {
      this.preOpen.push(data);
      return;
    }
    this.enqueuePost(data);
  }

  /** Encerra o canal: fecha o WebSocket e para de reconectar. */
  close(): void {
    this.closed = true;
    this.id = null;
    this.clearConnectTimer();
    if (this.reconnectTimer) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.dropWs(this.ws);
    this.mode = 'post';
    this.preOpen = [];
    this.pendingPost = '';
    this.wantSwitch = false;
  }

  // ---------------------------------------------------------------- WebSocket

  /** `background` = já temos o POST funcionando (reconexão): não muda o modo nem bufferiza, só reassume no open. */
  private openWs(background: boolean): void {
    if (!this.id || this.closed) return;
    if (!background) {
      this.mode = 'connecting';
      this.preOpen = [];
    }
    let ws: InputSocket;
    try {
      ws = this.openSocket(this.wsUrl(this.id));
    } catch {
      if (!background) this.fallbackToPost();
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => this.onOpen(ws));
    ws.addEventListener('close', () => this.onDown(ws));
    ws.addEventListener('error', () => this.onDown(ws));
    this.connectTimer = this.setTimer(() => {
      this.connectTimer = null;
      // Ainda não abriu: desiste deste socket, usa o POST e tenta de novo depois.
      if (this.ws === ws && this.mode !== 'ws') {
        this.dropWs(ws);
        this.fallbackToPost();
        this.scheduleReconnect();
      }
    }, this.connectTimeoutMs);
  }

  private onOpen(ws: InputSocket): void {
    if (ws !== this.ws || this.closed) return;
    this.clearConnectTimer();
    this.backoff = 0;
    if (this.mode === 'connecting') {
      this.mode = 'ws';
      const buffered = this.preOpen;
      this.preOpen = [];
      for (const d of buffered) this.wsSend(d);
    } else {
      // Reconectou com o POST ativo: só reassume quando a fila do POST esvaziar (ordem preservada).
      this.wantSwitch = true;
      this.maybeSwitchToWs();
    }
  }

  private onDown(ws: InputSocket): void {
    if (ws !== this.ws) return;
    this.clearConnectTimer();
    this.ws = null;
    this.wantSwitch = false;
    this.fallbackToPost();
    if (!this.closed) this.scheduleReconnect();
  }

  private wsSend(data: string): void {
    const ws = this.ws;
    if (!ws) return this.enqueuePost(data);
    try {
      ws.send(data);
    } catch {
      // Falhou no envio: não perde a tecla — cai para o POST e reconecta.
      this.onDown(ws);
      this.enqueuePost(data);
    }
  }

  /** Sai do modo 'connecting' mandando o que foi digitado por POST, na ordem. */
  private fallbackToPost(): void {
    if (this.mode === 'connecting' && this.preOpen.length) {
      for (const d of this.preOpen) this.enqueuePost(d);
    }
    this.preOpen = [];
    this.mode = 'post';
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || !this.id) return;
    const delay = Math.min(this.baseReconnectMs * 2 ** this.backoff, 10_000);
    this.backoff++;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (!this.closed && this.id && !this.ws) this.openWs(true);
    }, delay);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      this.clearTimer(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private dropWs(ws: InputSocket | null): void {
    if (!ws) return;
    if (this.ws === ws) this.ws = null;
    try {
      ws.close();
    } catch {
      // já caiu
    }
  }

  // ---------------------------------------------------------------- POST (reserva)

  private enqueuePost(data: string): void {
    this.pendingPost += data;
    if (this.postBusy) return;
    this.postBusy = true;
    void this.drainPost();
  }

  private async drainPost(): Promise<void> {
    while (this.pendingPost && !this.closed && this.id) {
      const chunk = this.pendingPost;
      this.pendingPost = '';
      const id = this.id;
      try {
        await this.post(`/api/pty/${encodeURIComponent(id)}/input`, { data: chunk });
      } catch {
        // A tecla seguinte ainda vai; o SSE mostra o estado real do terminal.
      }
    }
    this.postBusy = false;
    this.maybeSwitchToWs();
  }

  /** Com a fila do POST vazia e o WebSocket reaberto, volta a enviar pelo WebSocket. */
  private maybeSwitchToWs(): void {
    if (this.wantSwitch && !this.postBusy && this.pendingPost === '' && !this.closed && this.ws && this.ws.readyState === WS_OPEN) {
      this.wantSwitch = false;
      this.mode = 'ws';
    }
  }
}
