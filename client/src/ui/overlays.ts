// Camadas de estado: splash de carregamento, escritório vazio e aviso de conexão perdida.
import type { UiComponent, UiContext } from './context';
import { h, prefersReducedMotion, setHidden, setText } from './dom';
import { FALLBACK_MARK } from './icons';
import { emptyOfficeHint } from './provider';
import { wordmark } from './widgets';
import { tr } from '../../../shared/i18n';

/** Depois de quanto tempo sem conexão o aviso aparece. */
const DISCONNECTED_BANNER_MS = 8_000;

function brandMark(size: number): HTMLElement {
  const mark = h('span', { class: 'ui-brand__mark' });
  // Frinus Córtex: a tela de carregamento usa a logo do Frinus (SVG), não o prédio em pixel do Habblaud.
  const img = h('img', {
    attrs: { src: '/assets/brand/frinus-logo.svg', alt: '', width: size, height: size, draggable: 'false' },
    style: 'image-rendering:auto;object-fit:contain',
  });
  img.addEventListener('error', () => {
    mark.innerHTML = FALLBACK_MARK;
  });
  mark.append(img);
  return mark;
}

export class Splash implements UiComponent {
  readonly el: HTMLElement;
  private text: HTMLElement;
  private done = false;
  private readonly startedAt = performance.now();
  private tick: ReturnType<typeof setTimeout> | null = null;

  constructor(private ctx: UiContext) {
    this.text = h('p', { class: 'ui-splash__text', text: tr('Conectando ao córtex…') });
    this.el = h(
      'div',
      { class: 'ui-splash', role: 'status', attrs: { 'aria-live': 'polite' } },
      h('div', { class: 'ui-splash__inner' }, brandMark(64), wordmark('ui-splash__name'), this.text, h('span', { class: 'ui-splash__bar' })),
    );
  }

  render(): void {
    if (this.done) return;
    const { store } = this.ctx;
    if (store.snapshot) {
      this.done = true;
      this.el.classList.add('is-hidden');
      const remove = () => this.el.remove();
      if (prefersReducedMotion()) remove();
      else setTimeout(remove, 600);
      return;
    }
    const waited = performance.now() - this.startedAt;
    let text = tr('Conectando ao córtex…');
    if (waited > DISCONNECTED_BANNER_MS) text = tr('O servidor do Córtex não responde. Confira se ele está rodando (npm run dev ou npm start); seguimos tentando.');
    else if (store.connection === 'closed') text = tr('Não foi possível conectar ao servidor do Córtex. Tentando de novo…');
    setText(this.text, text);
    // Reavalia o texto mesmo sem eventos novos.
    this.tick ??= setTimeout(() => {
      this.tick = null;
      this.ctx.invalidate();
    }, 1_000);
  }
}

/** Conectado e sem nenhuma sessão: o cartão "escritório vazio" aparece (e os painéis não repetem o aviso). */
export function officeIsEmpty(ctx: UiContext): boolean {
  const { store } = ctx;
  const snap = store.snapshot;
  const connected = store.connection === 'open' || store.connection === 'mock';
  // No timelapse, um momento sem ninguém não é "abra o Claude Code (ou o Codex)".
  return connected && !store.replaying && !!snap && snap.agents.length === 0 && snap.rooms.length === 0;
}

export class EmptyState implements UiComponent {
  readonly el: HTMLElement;
  private hint: HTMLElement;
  private newChatBtn: HTMLButtonElement;

  constructor(private ctx: UiContext) {
    // Frinus Córtex: estado vazio limpo, sem a ilustração de escritório do Habblaud. Só um glifo neutro (um "córtex"
    // de pontos ligados, na cor de destaque do Frinus).
    const art = h('div', { class: 'ui-empty__art ui-empty__art--glyph', attrs: { 'aria-hidden': 'true' } });
    art.innerHTML =
      '<svg viewBox="0 0 64 64" width="64" height="64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      '<path d="M20 14 L44 22 L50 42 L30 52 L14 36 Z" opacity="0.5"/>' +
      '<circle cx="20" cy="14" r="3.2" fill="currentColor" stroke="none"/>' +
      '<circle cx="44" cy="22" r="3.2" fill="currentColor" stroke="none"/>' +
      '<circle cx="50" cy="42" r="3.2" fill="currentColor" stroke="none"/>' +
      '<circle cx="30" cy="52" r="3.2" fill="currentColor" stroke="none"/>' +
      '<circle cx="14" cy="36" r="3.2" fill="currentColor" stroke="none"/>' +
      '<circle cx="32" cy="33" r="4" fill="currentColor" stroke="none"/>' +
      '<path d="M32 33 L20 14 M32 33 L44 22 M32 33 L50 42 M32 33 L30 52 M32 33 L14 36" opacity="0.5"/>' +
      '</svg>';
    this.hint = h('p', { class: 'ui-empty__text' });
    // Sem nada acontecendo, o convite é começar uma conversa (nada de demonstração).
    this.newChatBtn = h('button', {
      class: 'ui-btn ui-btn--primary',
      type: 'button',
      text: tr('Nova conversa com o Frinus'),
      on: { click: () => this.ctx.openNewChat(this.newChatBtn) },
    }) as HTMLButtonElement;
    this.el = h(
      'section',
      { class: 'ui-empty', hidden: true, attrs: { 'aria-labelledby': 'ui-empty-title' } },
      art,
      h('h2', { class: 'ui-empty__title', text: tr('O córtex está vazio'), attrs: { id: 'ui-empty-title' } }),
      this.hint,
      this.newChatBtn,
    );
  }

  render(): void {
    const { store } = this.ctx;
    const snap = store.snapshot;
    const show = officeIsEmpty(this.ctx);
    setHidden(this.el, !show);
    if (!show || !snap) return;
    setText(this.hint, emptyOfficeHint(snap.accounts));
    setHidden(this.newChatBtn, store.mock);
  }
}

export class ConnectionBanner implements UiComponent {
  readonly el: HTMLElement;
  private since: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private text: HTMLElement;
  private retry: HTMLElement;

  constructor(private ctx: UiContext) {
    this.text = h('span');
    this.retry = h('span', { class: 'ui-banner__retry' });
    // A reconexão automática (com espera crescente) mora no store; o botão só antecipa a próxima tentativa.
    const retryBtn = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Tentar agora'), on: { click: () => ctx.store.reconnectNow() } });
    this.el = h(
      'div',
      { class: 'ui-banner', role: 'alert', hidden: true },
      h('span', { class: 'ui-banner__dot', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'ui-banner__text' }, this.text, this.retry),
      retryBtn,
    );
  }

  render(): void {
    const { store } = this.ctx;
    const conn = store.connection;
    const down = conn === 'connecting' || conn === 'closed';
    if (!down) {
      this.since = null;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      setHidden(this.el, true);
      return;
    }
    this.since ??= Date.now();
    const elapsed = Date.now() - this.since;
    if (elapsed < DISCONNECTED_BANNER_MS) {
      this.timer ??= setTimeout(() => {
        this.timer = null;
        this.ctx.invalidate();
      }, DISCONNECTED_BANNER_MS - elapsed + 50);
      return;
    }
    setText(
      this.text,
      store.snapshot
        ? tr('Sem conexão com o servidor do Córtex há algum tempo. O córtex mostra o último estado conhecido.')
        : tr('O servidor do Córtex não responde. Confira se ele está rodando (npm run dev ou npm start).'),
    );
    const next = store.nextRetryAt;
    const secs = next === null ? 0 : Math.max(1, Math.ceil((next - Date.now()) / 1000));
    setText(this.retry, next === null ? tr(' Tentando reconectar…') : tr(' Nova tentativa em {0} s.', [secs]));
    setHidden(this.el, false);
    // Atualiza a contagem regressiva a cada segundo enquanto o aviso estiver aberto.
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.ctx.invalidate();
    }, 1_000);
  }
}
