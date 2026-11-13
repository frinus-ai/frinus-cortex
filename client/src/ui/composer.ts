// Caixa de mensagem: manda um texto ao agente principal pelo Habblaud (POST /api/messages) e o plugin
// habblaud-mensagens o entrega à sessão como se você o tivesse digitado (no Codex, `codex queue` a põe na fila da
// sessão, que a usa quando fica ociosa). Fica na gaveta do agente e no rodapé do
// terminal (só a sessão ao vivo). Enter manda, Shift+Enter quebra a linha; a linha de situação acompanha a entrega
// (GET /api/messages/:id) até ela se resolver. As teclas digitadas aqui não disparam os atalhos globais. O rascunho de
// cada agente fica guardado (só na memória) ao trocar de agente. O microfone (ui/dictation.ts, Whisper local no Mac)
// põe o texto ditado no cursor; aparece quando o ditado funciona daqui. A lógica pura está em ui/composer-model.ts.
import { MESSAGE_MAX } from '../../../shared/messages';
import type { AgentInfo, OutboxMessage, Provider } from '../../../shared/types';
import {
  canSend,
  composerMode,
  composerTip,
  enterSends,
  isSettled,
  LOST_ERROR,
  messageText,
  OFFLINE_ERROR,
  POLL_LIMIT_MS,
  pollDelay,
  sendStatusText,
  timeoutError,
  type ComposerMode,
  type SendState,
} from './composer-model';
import type { UiContext } from './context';
import { formatPathForInsert, hasAttachment, resolveAttachment } from './attach';
import { postPty, ptyControllable } from './ptyapi';
import { DictationButton, dictationAvailable, insertDictation } from './dictation';
import { h, setAttr, setHidden, setText, setTitle } from './dom';
import { access } from '../net/access';
import { tr } from '../../../shared/i18n';

export type ComposerVariant = 'drawer' | 'terminal';

export interface ComposerOptions {
  /** Esc dentro da caixa: para onde vai o foco (padrão: só sai da caixa). */
  onEscape?: () => void;
}

export class MessageComposer {
  readonly el: HTMLElement;
  /** Agente da caixa (ou a chave da conversa, no terminal do histórico). */
  private agentId = '';
  private mode: ComposerMode = { kind: 'off', text: '' };
  /** Rascunho por agente: é ele que manda no conteúdo da caixa. */
  private drafts = new Map<string, string>();
  /** Último envio de cada agente (a linha de situação). */
  private states = new Map<string, SendState>();
  /** Ferramenta de cada agente que recebeu mensagem (o texto da entrega e do prazo muda no Codex). */
  private providers = new Map<string, Provider>();
  /** Ferramenta do agente da caixa. */
  private provider: Provider = 'claude';
  /** O que a caixa mostra agora ("<agente>|<pronta>"): ao mudar, o conteúdo vem do rascunho. */
  private shown = '';

  private row: HTMLElement;
  private box: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  /** "Assumir aqui": sessão rodando noutro terminal — traz para o escritório e a caixa passa a mandar. */
  private takeoverBtn: HTMLButtonElement;
  private hint: HTMLElement;
  private tip: HTMLElement | null;
  private status: HTMLElement;
  private dictate: DictationButton;
  /** Linha do ditado (gravando, transcrevendo, idioma, erro). */
  private dictStatus: HTMLElement;
  private dictTimer: ReturnType<typeof setTimeout> | null = null;
  /** Rascunho que recebe o ditado em andamento (o agente pode mudar enquanto o Mac transcreve). */
  private dictKey = '';
  private canDictate = false;

  constructor(
    private ctx: UiContext,
    private variant: ComposerVariant,
    private opts: ComposerOptions = {},
  ) {
    const term = variant === 'terminal';
    this.box = h('textarea', {
      class: `ui-msg__input${term ? ' ui-term__input' : ''}`,
      attrs: { rows: 1, maxlength: MESSAGE_MAX, autocomplete: 'off', enterkeyhint: 'send' },
    });
    this.box.addEventListener('input', () => {
      this.drafts.set(this.agentId, this.box.value);
      this.resize();
      this.syncButton();
    });
    this.box.addEventListener('focus', () => this.resize());
    this.box.addEventListener('keydown', (e) => this.onKey(e));
    // Arrastar e colar arquivos/imagens: vira o caminho absoluto no prompt (texto puro continua colando normal).
    this.box.addEventListener('paste', (e) => this.onPaste(e));
    this.box.addEventListener('dragover', (e) => this.onDragOver(e));
    this.box.addEventListener('dragleave', () => this.box.classList.remove('is-drop'));
    this.box.addEventListener('drop', (e) => this.onDrop(e));
    this.sendBtn = h(
      'button',
      {
        class: term ? 'ui-msg__send' : 'ui-btn ui-msg__send',
        type: 'button',
        title: tr('Mandar (Enter)'),
        attrs: { 'aria-label': tr('Mandar a mensagem') },
        on: { click: () => void this.send() },
      },
      term ? '↵' : tr('Enviar'),
    );
    this.dictStatus = h('p', { class: 'ui-msg__status ui-msg__dictation', role: 'status', hidden: true, attrs: { 'aria-live': 'polite' } });
    this.dictate = new DictationButton(
      (t) => this.insertDictated(t.text),
      (text, error) => this.sayDictation(text, error),
      { compact: true, onStart: () => (this.dictKey = this.agentId) },
    );
    this.dictate.el.classList.add('ui-msg__mic');
    setHidden(this.dictate.el, true);
    this.takeoverBtn = h(
      'button',
      {
        class: term ? 'ui-msg__send ui-msg__takeover' : 'ui-btn ui-msg__send ui-msg__takeover',
        type: 'button',
        title: tr('Trazer esta sessão para o córtex e mandar mensagens daqui'),
        on: { click: () => void this.ctx.terminals?.open(this.agentId) },
      },
      tr('Assumir aqui'),
    );
    setHidden(this.takeoverBtn, true);
    this.row = h('div', { class: `ui-msg__row${term ? ' ui-term__prompt ui-term__prompt--mic' : ''}` });
    if (term) this.row.append(h('span', { class: 'ui-term__caret', text: '>', attrs: { 'aria-hidden': 'true' } }));
    this.row.append(this.box, this.dictate.el, this.sendBtn, this.takeoverBtn);
    // Clique na "linha do prompt" (fora do botão) põe o cursor na caixa, como num terminal.
    this.row.addEventListener('mousedown', (e) => {
      if (e.target === this.row && !this.box.disabled) {
        e.preventDefault();
        this.box.focus();
      }
    });
    this.hint = h('p', { class: 'ui-msg__hint', hidden: true });
    this.status = h('p', { class: 'ui-msg__status', role: 'status', hidden: true, attrs: { 'aria-live': 'polite' } });
    this.tip = term ? null : h('p', { class: 'ui-msg__tip', text: composerTip() });
    this.el = h('div', { class: `ui-msg ui-msg--${variant}` }, this.hint, this.row, this.dictStatus, this.status, this.tip);
  }

  /**
   * Atualiza a caixa para `agent` (undefined = nenhum: sessão do histórico ou agente que saiu); `key` identifica o
   * rascunho. Devolve o modo: a gaveta esconde a seção quando é 'off'.
   */
  render(agent: AgentInfo | undefined, key = agent?.id ?? ''): ComposerMode['kind'] {
    const store = this.ctx.store;
    const snap = store.snapshot;
    const interactiveHere = !!agent && !!snap?.ptys?.some((p) => p.agentId === agent.id && p.exitedAt === undefined);
    const canInteractive = !!agent && !!snap?.meta.pty?.enabled && !store.replaying && ptyControllable(agent);
    const mode = composerMode(agent, {
      enabled: store.mock || !!store.snapshot?.meta.messages,
      local: store.mock || access().messages,
      replaying: store.replaying,
      interactiveHere,
      canInteractive,
    });
    this.mode = mode;
    const ready = mode.kind === 'ready';
    const takeover = mode.kind === 'takeover';
    // Texto quando a caixa não está pronta: motivo (off/hint) ou o convite a assumir (takeover).
    const reason = mode.kind === 'off' || mode.kind === 'hint' ? mode.text : takeover ? tr('Sessão em outro terminal — "Assumir aqui" para mandar daqui') : '';
    const term = this.variant === 'terminal';
    this.provider = agent?.provider === 'codex' ? 'codex' : 'claude';

    // Troca de agente (ou a caixa passou a valer/deixou de valer): o conteúdo vem do rascunho guardado.
    const shown = `${key}|${ready}`;
    if (shown !== this.shown) {
      // Gravando para outro agente: para sem transcrever (a fala era para aquele).
      this.dictate.cancel();
      this.shown = shown;
      this.agentId = key;
      this.box.value = ready ? (this.drafts.get(key) ?? '') : '';
      this.box.style.height = '';
      if (ready) requestAnimationFrame(() => this.resize());
    }
    this.box.disabled = !ready;
    const name = agent?.name ?? tr('o agente');
    const placeholder = ready ? (term ? tr('Mensagem para {0} (Enter manda, Shift+Enter quebra a linha)', [name]) : tr('Mensagem para {0}…', [name])) : reason;
    setAttr(this.box, 'placeholder', placeholder);
    setAttr(this.box, 'aria-label', ready ? tr('Mensagem para {0}', [name]) : reason);
    setTitle(this.box, ready ? '' : reason);
    this.row.classList.toggle('is-disabled', !ready);
    setHidden(this.sendBtn, !ready);
    setHidden(this.takeoverBtn, !takeover);
    // Consulta em cache (30 s): o Mac pode instalar o Whisper ou parar o auxiliar com a página aberta.
    void dictationAvailable().then((ok) => {
      if (ok === this.canDictate) return;
      this.canDictate = ok;
      this.ctx.invalidate();
    });
    // Transcrevendo: o botão fica até o texto chegar (ele vai para o rascunho de quem ditou).
    setHidden(this.dictate.el, !this.canDictate || (!ready && !this.dictate.busy));
    // Na gaveta, a caixa some quando não há o que fazer; com "Assumir aqui" (takeover) a linha continua à mostra.
    setHidden(this.row, !term && !ready && !takeover);
    if (this.tip) {
      setHidden(this.tip, !ready);
      setText(this.tip, composerTip(this.provider));
    }
    setHidden(this.hint, term || mode.kind !== 'hint');
    setText(this.hint, mode.kind === 'hint' ? mode.text : '');
    this.syncButton();

    const state = this.states.get(key);
    const text = sendStatusText(state, Date.now(), this.providers.get(key) ?? this.provider);
    setText(this.status, text);
    setHidden(this.status, !text);
    this.status.classList.toggle('is-error', state?.phase === 'failed' || state?.phase === 'rejected');
    this.status.classList.toggle('is-ok', state?.phase === 'delivered');
    return mode.kind;
  }

  // ---------------------------------------------------------------- internos

  private onKey(e: KeyboardEvent): void {
    // Os atalhos globais (F, T, P, /, setas...) não valem dentro da caixa. Com Ctrl/⌘ a tecla segue adiante
    // (Ctrl/⌘+F busca na conversa do terminal; os atalhos globais ignoram essas combinações).
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    if (e.key === 'Escape') {
      // Esc só sai da caixa (o próximo fecha o terminal ou a gaveta).
      e.preventDefault();
      e.stopPropagation();
      if (this.opts.onEscape) this.opts.onEscape();
      else this.box.blur();
      return;
    }
    if (enterSends(e)) {
      e.preventDefault();
      void this.send();
    }
  }

  /** Texto ditado: no cursor, se a caixa ainda é a de quem ditou; senão, no fim do rascunho daquele agente. */
  private insertDictated(text: string): void {
    const key = this.dictKey;
    if (key === this.agentId && !this.box.disabled) {
      const box = this.box;
      const { value, caret } = insertDictation(box.value, box.selectionStart ?? box.value.length, box.selectionEnd ?? box.value.length, text);
      box.value = value.slice(0, MESSAGE_MAX);
      this.drafts.set(key, box.value);
      this.resize();
      this.syncButton();
      box.focus({ preventScroll: true });
      box.setSelectionRange(caret, caret);
    } else {
      const cur = this.drafts.get(key) ?? '';
      this.drafts.set(key, insertDictation(cur, cur.length, cur.length, text).value.slice(0, MESSAGE_MAX));
    }
  }

  // ---------------------------------------------------------------- anexos (arrastar/colar)

  private onPaste(e: ClipboardEvent): void {
    const dt = e.clipboardData;
    if (!dt || this.box.disabled || !hasAttachment(dt.types)) return; // texto puro: deixa colar normal
    e.preventDefault();
    void this.attach(dt);
  }

  private onDragOver(e: DragEvent): void {
    if (this.box.disabled || !hasAttachment(e.dataTransfer?.types)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    this.box.classList.add('is-drop');
  }

  private onDrop(e: DragEvent): void {
    this.box.classList.remove('is-drop');
    const dt = e.dataTransfer;
    if (!dt || this.box.disabled || !hasAttachment(dt.types)) return;
    e.preventDefault();
    void this.attach(dt);
  }

  private async attach(dt: DataTransfer): Promise<void> {
    const { paths, hint } = await resolveAttachment({ types: dt.types, getData: (t) => dt.getData(t), fileCount: dt.files.length }, Array.from(dt.files));
    if (paths.length) this.insertPaths(paths);
    if (hint) this.sayDictation(hint, true);
  }

  /** Insere os caminhos no cursor da caixa (mesma lógica do ditado). */
  private insertPaths(paths: string[]): void {
    const box = this.box;
    const text = paths.map(formatPathForInsert).join(' ');
    const { value, caret } = insertDictation(box.value, box.selectionStart ?? box.value.length, box.selectionEnd ?? box.value.length, text);
    box.value = value.slice(0, MESSAGE_MAX);
    this.drafts.set(this.agentId, box.value);
    this.resize();
    this.syncButton();
    box.focus({ preventScroll: true });
    const c = Math.min(caret, box.value.length);
    box.setSelectionRange(c, c);
  }

  private sayDictation(text: string, error = false): void {
    if (this.dictTimer) clearTimeout(this.dictTimer);
    setText(this.dictStatus, text);
    setHidden(this.dictStatus, !text);
    this.dictStatus.classList.toggle('is-error', error);
    // Avisos de sucesso somem sozinhos; "Gravando…" e "Transcrevendo…" ficam até a próxima mudança.
    if (!error && !/…$/.test(text)) this.dictTimer = setTimeout(() => setHidden(this.dictStatus, true), 6_000);
  }

  private syncButton(): void {
    this.sendBtn.disabled = this.mode.kind !== 'ready' || !canSend(this.box.value) || this.states.get(this.agentId)?.phase === 'sending';
  }

  /** Cresce com o texto até o limite do CSS (~6 linhas; depois rola). Escondida, mede quando aparecer. */
  private resize(): void {
    const box = this.box;
    if (!box.isConnected || box.offsetParent === null) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
  }

  private setState(agentId: string, state: SendState): void {
    this.states.set(agentId, state);
    if (agentId === this.agentId) this.syncButton();
    this.ctx.invalidate();
  }

  /** Sessão do agente num terminal interativo deste escritório (para entregar pela stdin do pty). */
  private localPtyId(agentId: string): string | undefined {
    const agent = this.ctx.agent(agentId);
    if (!agent || agent.canMessage || agent.provider === 'codex') return undefined; // com o plugin, vai pela via normal
    return this.ctx.store.snapshot?.ptys?.find((p) => p.agentId === agentId && p.exitedAt === undefined)?.id;
  }

  private async send(): Promise<void> {
    const agentId = this.agentId;
    const raw = this.box.value;
    if (this.mode.kind !== 'ready' || !canSend(raw) || this.states.get(agentId)?.phase === 'sending') return;
    this.providers.set(agentId, this.provider);
    this.setState(agentId, { phase: 'sending', at: Date.now() });

    // Sem o plugin, mas com a sessão rodando aqui: entrega digitando na stdin do pty (como se você tivesse digitado).
    const ptyId = this.localPtyId(agentId);
    if (ptyId) {
      try {
        await postPty(`/api/pty/${encodeURIComponent(ptyId)}/input`, { data: `${messageText(raw)}\r` });
      } catch {
        this.setState(agentId, { phase: 'rejected', error: OFFLINE_ERROR, at: Date.now() });
        return;
      }
      if ((this.drafts.get(agentId) ?? '') === raw) {
        this.drafts.delete(agentId);
        if (this.agentId === agentId && this.box.value === raw) {
          this.box.value = '';
          this.resize();
        }
      }
      this.setState(agentId, { phase: 'delivered', at: Date.now() });
      return;
    }

    let r: { message: OutboxMessage } | { error: string };
    try {
      r = await this.ctx.store.sendMessage(agentId, messageText(raw));
    } catch {
      r = { error: OFFLINE_ERROR };
    }
    if ('error' in r) {
      // Recusada: o texto continua na caixa para tentar de novo.
      this.setState(agentId, { phase: 'rejected', error: r.error, at: Date.now() });
      return;
    }
    // Na fila: a caixa esvazia (a não ser que você tenha continuado a escrever enquanto o envio ia).
    if ((this.drafts.get(agentId) ?? '') === raw) {
      this.drafts.delete(agentId);
      if (this.agentId === agentId && this.box.value === raw) {
        this.box.value = '';
        this.resize();
      }
    }
    const m = r.message;
    this.setState(agentId, { phase: m.status, id: m.id, error: m.error, at: Date.now() });
    if (!isSettled(m.status)) this.poll(agentId, m.id, Date.now());
  }

  /** Consulta a situação até ela se resolver (ou o prazo acabar). Para quando outro envio toma a linha de situação. */
  private poll(agentId: string, id: string, since: number): void {
    const step = async () => {
      if (this.states.get(agentId)?.id !== id) return;
      let m: OutboxMessage | null | undefined;
      try {
        m = await this.ctx.store.messageStatus(id);
      } catch {
        // Sem conexão agora: tenta de novo na próxima volta.
      }
      const cur = this.states.get(agentId);
      if (cur?.id !== id) return;
      const now = Date.now();
      if (m === null) return this.setState(agentId, { phase: 'failed', id, error: LOST_ERROR, at: now });
      if (m && (m.status !== cur.phase || m.error !== cur.error)) this.setState(agentId, { phase: m.status, id, error: m.error, at: now });
      if (m && isSettled(m.status)) return;
      const elapsed = now - since;
      if (elapsed >= POLL_LIMIT_MS) return this.setState(agentId, { phase: 'failed', id, error: timeoutError(this.providers.get(agentId)), at: now });
      setTimeout(() => void step(), pollDelay(elapsed));
    };
    setTimeout(() => void step(), pollDelay(0));
  }
}
