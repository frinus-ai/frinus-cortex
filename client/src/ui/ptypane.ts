// Tela do terminal interativo (xterm.js) ligada a um pty do servidor (server/pty/manager.ts): saída pelo SSE
// GET /api/pty/:id/stream (reset | data | exit) e teclas/tamanho por POST. Carregado sob demanda (import
// dinâmico em ui/pty.ts): o xterm só entra quando alguém abre um terminal interativo.
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { postPty } from './ptyapi';
import { PtyInput } from './ptyinput';
import { formatPathForInsert, hasAttachment, resolveAttachment } from './attach';
import { copyText } from './dom';
import { tr } from '../../../shared/i18n';

const RESIZE_DEBOUNCE_MS = 120;

export class PtyPane {
  readonly el: HTMLElement;
  private term: Terminal;
  private fit: FitAddon;
  private es: EventSource | null = null;
  private id: string | null = null;
  private exited = false;
  /** Canal de entrada: WebSocket de baixa latência (uma mensagem por tecla), com POST /input de reserva. */
  private readonly input = new PtyInput();
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private ro: ResizeObserver;
  /** Camada de aviso de arrastar/colar (solte para anexar; erro de recent://). */
  private dropHint: HTMLElement;
  private dropTimer: ReturnType<typeof setTimeout> | null = null;
  /** Texto que o app mandou copiar (OSC 52) e o navegador recusou; vai no próximo Ctrl+Shift+C. */
  private osc52Pending: string | null = null;

  constructor(private onExit: () => void) {
    this.el = document.createElement('div');
    this.el.className = 'ui-pty__screen';
    this.term = new Terminal({
      cursorBlink: true,
      fontFamily: "'Cascadia Mono', Consolas, Menlo, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: { background: '#0a0c12', foreground: '#d5dceb', cursor: '#ffb547', selectionBackground: '#3a4a6b' },
      // Com o mouse capturado pelo app, Shift (Linux/Windows) ou Option (macOS) + arrastar força a seleção do xterm.
      macOptionClickForcesSelection: true,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.el);
    this.term.onData((d) => this.send(d));
    // Copiar: o xterm não copia sozinho (Ctrl+C vira ^C e o menu do botão direito não enxerga a seleção).
    // Ctrl+Shift+C (ou Cmd+C) copia a seleção; Ctrl+C copia se houver seleção, senão segue como ^C;
    // Ctrl+Shift+V cola pelo caminho nativo; botão direito com seleção copia.
    this.term.attachCustomKeyEventHandler((e) => this.onKey(e));
    // Claude Code em tela cheia ("tui": "fullscreen") captura o mouse, faz a seleção ele mesmo e copia pela
    // sequência OSC 52. O xterm ignora essa sequência por padrão: sem este handler, nada chega à área de transferência.
    this.term.parser.registerOscHandler(52, (data) => {
      void this.onOsc52(data);
      return true;
    });
    // Com o mouse capturado (Claude Code em tela cheia pede todo movimento), o xterm trata cada movimento informado
    // como digitação e apaga a seleção: ao soltar o botão e mexer o mouse, o texto selecionado sumia antes do
    // Ctrl+C. Enquanto houver seleção, o movimento sem botão não chega ao xterm (fase de captura, antes dele).
    this.el.addEventListener(
      'mousemove',
      (e) => {
        if (!e.buttons && this.term.hasSelection()) e.stopPropagation();
      },
      true,
    );
    this.el.addEventListener('contextmenu', (e) => {
      if (!this.term.hasSelection()) return;
      e.preventDefault();
      void this.copySelection();
    });
    this.term.onResize(({ cols, rows }) => this.scheduleResize(cols, rows));
    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(this.el);
    // Arrastar e colar arquivos/imagens: viram o caminho absoluto digitado no terminal (texto puro cola normal).
    this.dropHint = document.createElement('div');
    this.dropHint.className = 'ui-pty__drop';
    this.dropHint.hidden = true;
    this.el.appendChild(this.dropHint);
    this.el.addEventListener('dragover', (e) => this.onDragOver(e));
    this.el.addEventListener('dragleave', (e) => this.onDragLeave(e));
    this.el.addEventListener('drop', (e) => this.onDrop(e));
    // Captura: pega o colar de arquivo ANTES do textarea escondido do xterm (que só saberia colar texto).
    this.el.addEventListener('paste', (e) => this.onPaste(e), true);
  }

  // ---------------------------------------------------------------- copiar/colar texto

  private onKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return true;
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return true;
    if (key === 'c' && (e.shiftKey || e.metaKey || this.term.hasSelection())) {
      if (!this.term.hasSelection()) {
        // Ctrl+Shift+C sem seleção: copia o que o app pediu via OSC 52 e o navegador barrou; nunca manda nada ao Claude.
        if (this.osc52Pending !== null) {
          e.preventDefault();
          void this.copyPendingOsc52();
        }
        return false;
      }
      e.preventDefault();
      void this.copySelection();
      return false;
    }
    // Ctrl+Shift+V / Cmd+V: deixa o navegador disparar o "paste" nativo (o xterm e o onPaste cuidam dele).
    if (key === 'v' && (e.shiftKey || e.metaKey)) return false;
    return true;
  }

  /** OSC 52 = "<alvos>;<base64>". "?" é consulta de leitura da área de transferência: nunca respondemos (vazaria dados). */
  private async onOsc52(data: string): Promise<void> {
    const sep = data.indexOf(';');
    const b64 = sep >= 0 ? data.slice(sep + 1) : data;
    if (!b64 || b64 === '?') return;
    let text: string;
    try {
      text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    } catch {
      return;
    }
    if (!text) return;
    if (await copyText(text)) {
      this.osc52Pending = null;
      this.showDrop(tr('Copiado'), false, 1_200, true);
      return;
    }
    // Sem gesto do usuário o navegador pode recusar a escrita: guarda e copia no próximo Ctrl+Shift+C.
    this.osc52Pending = text;
    this.showDrop(tr('Aperte Ctrl+Shift+C para copiar'), false, 4_000, true);
  }

  private async copyPendingOsc52(): Promise<void> {
    const text = this.osc52Pending;
    if (text === null) return;
    const ok = await copyText(text);
    if (ok) this.osc52Pending = null;
    this.term.focus();
    this.showDrop(ok ? tr('Copiado') : tr('Não foi possível copiar'), !ok, ok ? 1_200 : 4_000, true);
  }

  private async copySelection(): Promise<void> {
    const text = this.term.getSelection();
    if (!text) return;
    const ok = await copyText(text);
    this.term.clearSelection();
    this.term.focus();
    this.showDrop(ok ? tr('Copiado') : tr('Não foi possível copiar'), !ok, ok ? 1_200 : 4_000, true);
  }

  // ---------------------------------------------------------------- anexos (arrastar/colar)

  private onDragOver(e: DragEvent): void {
    if (!this.id || this.exited || !hasAttachment(e.dataTransfer?.types)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    this.showDrop(tr('Solte para anexar (vira o caminho no prompt)'), false);
  }

  private onDragLeave(e: DragEvent): void {
    if (!this.el.contains(e.relatedTarget as Node | null)) this.hideDrop();
  }

  private onDrop(e: DragEvent): void {
    const dt = e.dataTransfer;
    this.hideDrop();
    if (!dt || !this.id || this.exited || !hasAttachment(dt.types)) return;
    e.preventDefault();
    void this.attachFromTransfer(dt);
  }

  private onPaste(e: ClipboardEvent): void {
    const dt = e.clipboardData;
    if (!dt || !this.id || this.exited || !hasAttachment(dt.types)) return; // texto puro: deixa o xterm colar
    e.preventDefault();
    e.stopPropagation();
    void this.attachFromTransfer(dt);
  }

  private async attachFromTransfer(dt: DataTransfer): Promise<void> {
    const { paths, hint } = await resolveAttachment({ types: dt.types, getData: (t) => dt.getData(t), fileCount: dt.files.length }, Array.from(dt.files));
    if (paths.length) {
      this.send(`${paths.map(formatPathForInsert).join(' ')} `);
      this.term.focus();
    }
    if (hint) this.showDrop(hint, true);
  }

  private showDrop(text: string, error: boolean, ms = 6_000, toast = false): void {
    if (this.dropTimer) {
      clearTimeout(this.dropTimer);
      this.dropTimer = null;
    }
    this.dropHint.textContent = text;
    this.dropHint.hidden = false;
    this.dropHint.classList.toggle('is-error', error);
    this.dropHint.classList.toggle('is-toast', toast);
    // Erros e avisos curtos somem sozinhos; a dica de "solte aqui" some no dragleave/drop.
    if (error || toast) this.dropTimer = setTimeout(() => this.hideDrop(), ms);
  }

  private hideDrop(): void {
    if (this.dropTimer) {
      clearTimeout(this.dropTimer);
      this.dropTimer = null;
    }
    this.dropHint.hidden = true;
    this.dropHint.classList.remove('is-error', 'is-toast');
  }

  get ptyId(): string | null {
    return this.id;
  }

  /** Liga a tela a um pty do servidor (outro pty = tela nova). */
  attach(id: string): void {
    if (this.id === id && this.es) return;
    this.detach();
    this.id = id;
    this.exited = false;
    this.term.reset();
    this.input.attach(id);
    const es = new EventSource(`/api/pty/${encodeURIComponent(id)}/stream`);
    this.es = es;
    es.addEventListener('reset', (e) => {
      this.term.reset();
      this.term.write(parse(e));
      this.refit(true);
    });
    es.addEventListener('data', (e) => this.term.write(parse(e)));
    es.addEventListener('exit', (e) => {
      this.exited = true;
      let code = 0;
      try {
        code = (JSON.parse((e as MessageEvent<string>).data) as { code?: number }).code ?? 0;
      } catch {
        // sem código
      }
      this.term.write(`\r\n\x1b[2m[${code ? tr('Claude Code encerrado (código {0})', [code]) : tr('Claude Code encerrado')}]\x1b[0m\r\n`);
      es.close();
      this.input.close();
      this.onExit();
    });
  }

  detach(): void {
    this.es?.close();
    this.es = null;
    this.id = null;
    this.input.close();
  }

  focus(): void {
    this.term.focus();
  }

  /** Reajusta colunas/linhas ao tamanho do elemento (`force` reenvia ao servidor mesmo sem mudança). */
  refit(force = false): void {
    if (!this.el.isConnected || this.el.clientWidth < 40 || this.el.clientHeight < 40) return;
    const before = `${this.term.cols}x${this.term.rows}`;
    try {
      this.fit.fit();
    } catch {
      return;
    }
    if (force && before === `${this.term.cols}x${this.term.rows}`) this.scheduleResize(this.term.cols, this.term.rows);
  }

  private send(data: string): void {
    if (!this.id || this.exited) return;
    this.input.send(data);
  }

  private scheduleResize(cols: number, rows: number): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      if (this.id && !this.exited) void postPty(`/api/pty/${encodeURIComponent(this.id)}/resize`, { cols, rows }).catch(() => undefined);
    }, RESIZE_DEBOUNCE_MS);
  }
}

function parse(e: Event): string {
  try {
    const v = JSON.parse((e as MessageEvent<string>).data) as unknown;
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}
