// "Nova conversa com o Frinus" (botão em destaque na barra do topo): abre uma sessão interativa do Claude Code já
// como o orquestrador frinus (o escritório roda frinus-claude = `claude --agent frinus`), na CONTA e na PASTA
// escolhidas — reaproveitando o terminal interativo (PtyManager, que já exporta o CLAUDE_CONFIG_DIR da conta).
//
// A mesma janela também traz "Adicionar conta Frinus": cadastra uma conta nova (apelido + chave) pelo servidor
// (POST /api/frinus/accounts), que cria ~/.claude-<apelido>, liga o MCP do Frinus, instala o mod e a faz aparecer na
// hora. A chave vai só no corpo do POST (rota local), NUNCA é guardada no navegador nem volta na resposta.
import { tr } from '../../../shared/i18n';
import { isDemoId } from '../../../shared/timeline';
import type { AccountInfo } from '../../../shared/types';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';

const FOLDER_KEY = 'frinus.newchat.folder';
const ACCOUNT_KEY = 'frinus.newchat.account';
const MODE_KEY = 'frinus.newchat.mode';
/** Modos de permissão (os mesmos de server/pty/manager.ts PERMISSION_MODES). Bypass é o padrão, como nos aliases e no instalador. */
const MODES: ReadonlyArray<{ id: string; label: () => string }> = [
  { id: 'bypassPermissions', label: () => tr('Bypass completo (não pede permissão)') },
  { id: 'auto', label: () => tr('Auto (o Claude decide o que pedir)') },
  { id: 'acceptEdits', label: () => tr('Aceitar edições (pede para comandos)') },
  { id: 'plan', label: () => tr('Planejar (só lê e propõe)') },
  { id: 'default', label: () => tr('Pedir permissão para tudo') },
];
const DEFAULT_MODE = 'bypassPermissions';
const FOLDER_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

/** Contas que dá para usar numa conversa Frinus: as do Claude Code (não Codex, não demo). Com FRINUS_ONLY, já são as com Frinus. */
function frinusAccounts(snap: { accounts?: AccountInfo[] } | null | undefined): AccountInfo[] {
  return (snap?.accounts ?? []).filter((a) => (a.provider ?? 'claude') === 'claude' && !isDemoId(a.id));
}

function folderIcon(): HTMLElement {
  const el = h('span', { class: 'ui-newchat__folder-icon', attrs: { 'aria-hidden': 'true' } });
  el.innerHTML = FOLDER_ICON;
  return el;
}

function readPref(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // sem armazenamento: só não lembra
  }
}

export class NewChatPanel implements UiComponent {
  readonly el: HTMLDialogElement;
  private opener: HTMLElement | null = null;
  private busy = false;
  /** Conta a selecionar quando aparecer no snapshot (recém-criada). */
  private pendingAccount: string | null = null;
  private accountSig = '';

  /** Lista de contas em cartões (rádio), no lugar do <select> nativo. */
  private readonly accountList: HTMLElement;
  private accountValue = '';
  private readonly accountEmpty: HTMLElement;
  private readonly folderInput: HTMLInputElement;
  private readonly folderPick: HTMLButtonElement;
  private readonly modeSelect: HTMLSelectElement;
  private picking = false;
  private readonly startBtn: HTMLButtonElement;
  private readonly startMsg: HTMLElement;
  private readonly disabledMsg: HTMLElement;

  private readonly addWrap: HTMLElement;
  private readonly addToggle: HTMLButtonElement;
  private readonly aliasInput: HTMLInputElement;
  private readonly keyInput: HTMLInputElement;
  private readonly addBtn: HTMLButtonElement;
  private readonly addMsg: HTMLElement;

  constructor(private ctx: UiContext) {
    const close = iconButton(ICONS.close, tr('Fechar'), () => this.el.close(), 'ui-icon-btn--sm');

    this.accountList = h('div', { class: 'ui-newchat__accounts', attrs: { role: 'radiogroup', 'aria-label': tr('Conta do Frinus') } });
    this.accountEmpty = h('p', { class: 'ui-mem-status', text: tr('Nenhuma conta Frinus ainda. Adicione uma abaixo.'), hidden: true });
    // O caminho fica visível e editável, mas o jeito principal é o botão, que abre o seletor de pasta do SO.
    this.folderInput = h('input', {
      class: 'ui-mem-input ui-newchat__folder-input',
      type: 'text',
      attrs: { placeholder: '~/Frinus', 'aria-label': tr('Pasta do projeto'), spellcheck: 'false', autocapitalize: 'off' },
    }) as HTMLInputElement;
    this.folderPick = h(
      'button',
      { class: 'ui-btn ui-newchat__folder-pick', type: 'button', attrs: { title: tr('Abrir o seletor de pastas do sistema') }, on: { click: () => void this.pickFolder() } },
      folderIcon(),
      h('span', { text: tr('Escolher…') }),
    ) as HTMLButtonElement;
    this.modeSelect = h(
      'select',
      { class: 'ui-mem-input ui-newchat__mode', attrs: { 'aria-label': tr('Modo de permissão') } },
      ...MODES.map((m) => h('option', { text: m.label(), attrs: { value: m.id } })),
    ) as HTMLSelectElement;
    this.startBtn = h('button', { class: 'ui-btn ui-btn--accent ui-newchat__start', type: 'button', text: tr('Começar conversa'), on: { click: () => void this.start() } }) as HTMLButtonElement;
    this.startMsg = h('p', { class: 'ui-mem-status', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.disabledMsg = h('p', { class: 'ui-mem-status is-error', hidden: true });

    const startPane = h(
      'div',
      { class: 'ui-newchat__pane' },
      h('div', { class: 'ui-newchat__field' }, h('span', { class: 'ui-newchat__label', text: tr('Conta') }), this.accountList),
      this.accountEmpty,
      h(
        'div',
        { class: 'ui-newchat__field' },
        h('span', { class: 'ui-newchat__label', text: tr('Pasta') }),
        h('div', { class: 'ui-newchat__folder' }, this.folderInput, this.folderPick),
      ),
      h('label', { class: 'ui-newchat__field' }, h('span', { class: 'ui-newchat__label', text: tr('Modo') }), this.modeSelect),
      h('div', { class: 'ui-newchat__actions' }, this.startBtn),
      this.startMsg,
      this.disabledMsg,
    );

    // --- Adicionar conta (recolhido por padrão) ---
    this.aliasInput = h('input', {
      class: 'ui-mem-input',
      type: 'text',
      attrs: { placeholder: tr('apelido (ex.: monetizze)'), 'aria-label': tr('Apelido da conta'), spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off' },
    }) as HTMLInputElement;
    // A chave é segredo: type=password, sem autocomplete, nunca guardada.
    this.keyInput = h('input', {
      class: 'ui-mem-input',
      type: 'password',
      attrs: { placeholder: 'sk-frinus-…', 'aria-label': tr('Chave do Frinus'), autocomplete: 'off', spellcheck: 'false' },
    }) as HTMLInputElement;
    this.addBtn = h('button', { class: 'ui-btn ui-newchat__add-go', type: 'button', text: tr('Adicionar conta'), on: { click: () => void this.addAccount() } }) as HTMLButtonElement;
    this.addMsg = h('p', { class: 'ui-mem-status', attrs: { role: 'status', 'aria-live': 'polite' } });
    const addBody = h(
      'div',
      { class: 'ui-newchat__add-body', hidden: true },
      h('p', { class: 'ui-muted ui-small', text: tr('Cria ~/.claude-<apelido>, liga a memória do Frinus e instala tudo. A chave não é guardada no navegador.') }),
      h('label', { class: 'ui-newchat__field' }, h('span', { class: 'ui-newchat__label', text: tr('Apelido') }), this.aliasInput),
      h('label', { class: 'ui-newchat__field' }, h('span', { class: 'ui-newchat__label', text: tr('Chave') }), this.keyInput),
      h('div', { class: 'ui-newchat__actions' }, this.addBtn),
      this.addMsg,
    );
    this.addToggle = h('button', {
      class: 'ui-newchat__add-toggle',
      type: 'button',
      attrs: { 'aria-expanded': 'false' },
      text: tr('+ Adicionar conta Frinus'),
      on: { click: () => this.toggleAdd(addBody) },
    }) as HTMLButtonElement;
    this.addWrap = h('div', { class: 'ui-newchat__add' }, this.addToggle, addBody);

    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-newchat', attrs: { 'aria-labelledby': 'ui-newchat-title' } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { text: tr('Nova conversa com o Frinus'), attrs: { id: 'ui-newchat-title' } }), close),
      h('div', { class: 'ui-dialog__body ui-newchat__body' }, startPane, this.addWrap),
    ) as HTMLDialogElement;

    this.el.addEventListener('close', () => {
      // A chave nunca permanece: limpa ao fechar.
      this.keyInput.value = '';
      this.opener?.focus();
      this.opener = null;
    });
    // Teclas do diálogo não disparam atalhos do escritório.
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  toggle(opener?: HTMLElement | null): void {
    if (this.el.open) this.el.close();
    else this.open(opener);
  }

  open(opener?: HTMLElement | null): void {
    this.opener = opener ?? null;
    if (!this.el.open) this.el.showModal();
    this.populate(true);
    this.render();
    requestAnimationFrame(() => (frinusAccounts(this.ctx.store.snapshot).length ? this.startBtn : this.aliasInput).focus());
  }

  private toggleAdd(body: HTMLElement): void {
    const open = body.hidden;
    setHidden(body, !open);
    this.addToggle.setAttribute('aria-expanded', String(open));
    if (open) requestAnimationFrame(() => this.aliasInput.focus());
  }

  /** (Re)preenche a lista de contas a partir do snapshot, preservando a escolha atual (ou a conta recém-criada). */
  private populate(reset = false): void {
    const accts = frinusAccounts(this.ctx.store.snapshot);
    let want = this.pendingAccount ?? (reset ? readPref(ACCOUNT_KEY) : this.accountValue);
    if (want && accts.some((a) => a.id === want)) {
      if (this.pendingAccount === want) this.pendingAccount = null;
    } else want = accts[0]?.id ?? '';
    this.accountValue = want;
    // Só reconstrói quando a lista ou a escolha mudam (render() roda a cada snapshot; preserva o foco).
    const sig = accts.map((a) => `${a.id}|${a.name}|${a.organization ?? ''}|${a.email ?? ''}`).join('\n') + `#${want}`;
    if (sig !== this.accountSig) {
      this.accountSig = sig;
      const focused = this.accountList.contains(document.activeElement);
      this.accountList.textContent = '';
      for (const a of accts) {
        const sub = a.organization || a.email || '';
        const on = a.id === want;
        const card = h(
          'button',
          {
            class: `ui-newchat__account${on ? ' is-selected' : ''}`,
            type: 'button',
            attrs: { role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1', 'data-id': a.id },
            on: {
              click: () => this.selectAccount(a.id, true),
              keydown: (e: Event) => this.onAccountKey(e as KeyboardEvent, accts.map((x) => x.id)),
            },
          },
          h('span', { class: 'ui-newchat__account-dot', attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'ui-newchat__account-text' }, h('span', { class: 'ui-newchat__account-name', text: a.name }), sub ? h('span', { class: 'ui-newchat__account-sub', text: sub }) : null),
        );
        this.accountList.append(card);
      }
      if (focused) (this.accountList.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus();
    }
    setHidden(this.accountEmpty, accts.length > 0);
    if (reset) {
      const mode = readPref(MODE_KEY);
      this.modeSelect.value = MODES.some((m) => m.id === mode) ? mode : DEFAULT_MODE;
    }
    if (reset && !this.folderInput.value) {
      const home = this.ctx.store.snapshot?.meta.home;
      this.folderInput.value = readPref(FOLDER_KEY) || (home ? `${home.replace(/\/+$/, '')}/Frinus` : '');
    }
  }

  render(): void {
    if (!this.el.open) return;
    this.populate();
    const enabled = !!this.ctx.terminals?.interactiveEnabled;
    const hasAccount = frinusAccounts(this.ctx.store.snapshot).length > 0;
    this.startBtn.disabled = this.busy || !enabled || !hasAccount;
    setHidden(this.accountList, !hasAccount);
    this.folderPick.disabled = this.picking || this.busy;
    this.modeSelect.disabled = this.busy;
    setText(this.disabledMsg, enabled ? '' : tr('O terminal interativo está desligado neste escritório.'));
    setHidden(this.disabledMsg, enabled);
  }

  private async start(): Promise<void> {
    if (this.busy) return;
    const account = this.accountValue;
    const folder = this.folderInput.value.trim();
    const mode = this.modeSelect.value || DEFAULT_MODE;
    if (!account) return this.say(this.startMsg, tr('Escolha uma conta.'), true);
    if (!folder) return this.say(this.startMsg, tr('Informe a pasta (caminho absoluto, ex.: /home/voce/Frinus).'), true);
    this.busy = true;
    this.render();
    this.say(this.startMsg, tr('Abrindo…'), false);
    try {
      await this.ctx.terminals?.newSession(folder, account, mode);
      writePref(FOLDER_KEY, folder);
      writePref(ACCOUNT_KEY, account);
      writePref(MODE_KEY, mode);
      this.el.close();
    } catch (err) {
      this.say(this.startMsg, tr('Não deu: {0}', [(err as Error).message]), true);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async addAccount(): Promise<void> {
    if (this.busy) return;
    const alias = this.aliasInput.value.trim();
    const apiKey = this.keyInput.value;
    if (!alias) return this.say(this.addMsg, tr('Dê um apelido à conta (ex.: monetizze).'), true);
    if (!apiKey.trim()) return this.say(this.addMsg, tr('Cole a chave do Frinus (sk-frinus-…).'), true);
    this.busy = true;
    this.addBtn.disabled = true;
    this.say(this.addMsg, tr('Criando a conta… (pode levar alguns segundos)'), false);
    let res: Response;
    try {
      res = await fetch('/api/frinus/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias, apiKey }),
      });
    } catch {
      this.keyInput.value = '';
      this.busy = false;
      this.addBtn.disabled = false;
      return this.say(this.addMsg, tr('O Frinus Office não respondeu.'), true);
    }
    // A chave sai da memória do navegador assim que o pedido parte (sucesso ou erro).
    this.keyInput.value = '';
    const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; error?: string };
    this.busy = false;
    this.addBtn.disabled = false;
    if (!res.ok) return this.say(this.addMsg, body.error ?? tr('Não foi possível criar a conta.'), true);
    this.aliasInput.value = '';
    this.pendingAccount = body.id ?? null;
    this.say(this.addMsg, tr('Conta "{0}" criada e conectada.', [body.name ?? alias]), false);
    this.ctx.invalidate();
    this.populate();
    this.render();
  }

  private selectAccount(id: string, focus: boolean): void {
    this.accountValue = id;
    this.populate();
    if (focus) (this.accountList.querySelector(`[data-id="${CSS.escape(id)}"]`) as HTMLElement | null)?.focus();
  }

  /** Setas/Home/End movem a escolha, como num grupo de rádio. */
  private onAccountKey(e: KeyboardEvent, ids: string[]): void {
    const i = ids.indexOf(this.accountValue);
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (i + 1) % ids.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    if (next < 0) return;
    e.preventDefault();
    this.selectAccount(ids[next], true);
  }

  /** Abre o seletor de pastas do SO pelo servidor local (o navegador não dá o caminho absoluto). */
  private async pickFolder(): Promise<void> {
    if (this.picking) return;
    this.picking = true;
    this.render();
    this.say(this.startMsg, tr('Escolha a pasta na janela do sistema…'), false);
    try {
      const res = await fetch('/api/frinus/pick-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start: this.folderInput.value.trim() || undefined }),
      });
      const body = (await res.json().catch(() => ({}))) as { path?: string; cancelled?: boolean; error?: string };
      if (res.ok && body.path) {
        this.folderInput.value = body.path;
        this.say(this.startMsg, '', false);
        this.startBtn.focus();
      } else if (res.ok && body.cancelled) {
        this.say(this.startMsg, '', false);
      } else {
        this.say(this.startMsg, tr('Seletor de pastas indisponível aqui: digite o caminho.'), true);
        this.folderInput.focus();
      }
    } catch {
      this.say(this.startMsg, tr('O Frinus Office não respondeu.'), true);
    } finally {
      this.picking = false;
      this.render();
    }
  }

  private say(el: HTMLElement, text: string, error: boolean): void {
    setText(el, text);
    el.classList.toggle('is-error', error);
  }
}
