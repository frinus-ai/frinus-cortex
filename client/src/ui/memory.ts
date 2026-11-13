// Busca na memória do Frinus (botão de lupa na barra do topo): uma janela com duas abas —
// "Buscar memória" (POST /api/frinus/memory/search) e "Tarefas" (GET /api/frinus/tasks). O servidor fala com a Memory Engine usando a chave da conta
// escolhida (frinus-mcp no .claude.json); a chave nunca chega ao navegador. Ver server/http/frinus.ts.
import { intlLocale, tr } from '../../../shared/i18n';
import type { UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';

type TabId = 'search' | 'tasks';

interface AccountSummary {
  id: string;
  label: string;
  organization?: string;
  isDefault: boolean;
}

interface MemoryResult {
  id: string;
  memory_type: string;
  content: string;
  importance: number;
  created_at: string;
  similarity: number | null;
  context_path: string | null;
  universe_id: string | null;
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  priority: number;
  created_at: string | null;
}

const LOCALE = intlLocale();

/** Rótulos legíveis por tipo de memória (o resto fica como veio). */
function typeLabel(t: string): string {
  if (t === 'semantic') return tr('Fato');
  if (t === 'episodic') return tr('Evento');
  if (t === 'procedural') return tr('Procedimento');
  return t;
}

/** Data curta e local (ex.: "12 nov 2026"); vazio quando não dá para interpretar. */
function shortDate(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  try {
    return new Date(t).toLocaleDateString(LOCALE, { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return new Date(t).toISOString().slice(0, 10);
  }
}

async function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' });
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch {
    throw new Error(tr('o Frinus Córtex não respondeu'));
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body?.error || tr('não foi possível concluir a busca'));
  return body;
}

export class MemorySearchPanel {
  readonly el: HTMLDialogElement;
  private opener: HTMLElement | null = null;
  private tab: TabId = 'search';
  private accounts: AccountSummary[] = [];
  private accountId = '';
  private accountsLoaded = false;

  private readonly tabBtns = new Map<TabId, HTMLButtonElement>();
  private readonly panes = new Map<TabId, HTMLElement>();
  private readonly accountRow: HTMLElement;
  private readonly accountSelect: HTMLSelectElement;
  private readonly accountSingle: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchStatus: HTMLElement;
  private readonly searchResults: HTMLElement;
  private readonly tasksStatus: HTMLElement;
  private readonly tasksList: HTMLElement;

  constructor(private ctx: UiContext) {
    const close = iconButton(ICONS.close, tr('Fechar busca de memória'), () => this.el.close(), 'ui-icon-btn--sm');

    // Abas
    const mkTab = (id: TabId, label: string): HTMLButtonElement => {
      const b = h('button', {
        class: 'ui-mem-tab',
        type: 'button',
        role: 'tab',
        text: label,
        on: { click: () => this.switchTab(id) },
      });
      this.tabBtns.set(id, b);
      return b;
    };
    const tabs = h(
      'div',
      { class: 'ui-mem-tabs', role: 'tablist', attrs: { 'aria-label': tr('Seções da memória') } },
      mkTab('search', tr('Buscar memória')),
      mkTab('tasks', tr('Tarefas')),
    );

    // Conta (seletor quando há mais de uma; rótulo fixo quando só há uma)
    this.accountSelect = h('select', { class: 'ui-mem-account', attrs: { 'aria-label': tr('Conta do Frinus') }, on: { change: () => this.onAccountChange() } }) as HTMLSelectElement;
    this.accountSingle = h('span', { class: 'ui-mem-account-single' });
    this.accountRow = h(
      'div',
      { class: 'ui-mem-accountrow', hidden: true },
      h('span', { class: 'ui-mem-accountrow__label', text: tr('Conta') }),
      this.accountSelect,
      this.accountSingle,
    );

    // Aba Buscar
    this.searchInput = h('input', {
      class: 'ui-mem-input',
      type: 'search',
      attrs: { placeholder: tr('Buscar na memória (ex.: Frinus Córtex)'), 'aria-label': tr('Termo de busca'), enterkeyhint: 'search' },
      on: {
        keydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void this.runSearch();
          }
        },
      },
    }) as HTMLInputElement;
    const searchBtn = h('button', { class: 'ui-btn--accent ui-mem-go', type: 'button', text: tr('Buscar'), on: { click: () => void this.runSearch() } });
    this.searchStatus = h('p', { class: 'ui-mem-status', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.searchResults = h('ul', { class: 'ui-mem-results' });
    this.panes.set(
      'search',
      h(
        'div',
        { class: 'ui-mem-pane', role: 'tabpanel' },
        h('div', { class: 'ui-mem-searchbar' }, this.searchInput, searchBtn),
        this.searchStatus,
        this.searchResults,
      ),
    );

    // Aba Tarefas
    this.tasksStatus = h('p', { class: 'ui-mem-status', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.tasksList = h('ul', { class: 'ui-mem-tasks' });
    this.panes.set('tasks', h('div', { class: 'ui-mem-pane', role: 'tabpanel' }, this.tasksStatus, this.tasksList));

    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-mem', attrs: { 'aria-labelledby': 'ui-mem-title' } },
      h(
        'div',
        { class: 'ui-dialog__head' },
        h('h2', { text: tr('Memória do Frinus'), attrs: { id: 'ui-mem-title' } }),
        close,
      ),
      h('div', { class: 'ui-mem-top' }, tabs, this.accountRow),
      h('div', { class: 'ui-dialog__body ui-mem-body' }, this.panes.get('search')!, this.panes.get('tasks')!),
    ) as HTMLDialogElement;

    this.el.addEventListener('close', () => {
      this.opener?.focus();
      this.opener = null;
    });

    this.syncTabs();
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
    void this.ensureAccounts().then(() => {
      if (this.tab === 'search') this.searchInput.focus();
    });
  }

  // ---------------------------------------------------------------- abas

  private switchTab(id: TabId): void {
    this.tab = id;
    this.syncTabs();
    if (id === 'search') this.searchInput.focus();
    else if (id === 'tasks') void this.loadTasks();
  }

  private syncTabs(): void {
    for (const [id, btn] of this.tabBtns) {
      const active = id === this.tab;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
      btn.tabIndex = active ? 0 : -1;
    }
    for (const [id, pane] of this.panes) setHidden(pane, id !== this.tab);
  }

  // ---------------------------------------------------------------- contas

  private async ensureAccounts(): Promise<void> {
    if (this.accountsLoaded) return;
    try {
      const r = await apiGet<{ accounts: AccountSummary[] }>('/api/frinus/accounts');
      this.accounts = r.accounts ?? [];
      this.accountsLoaded = true;
      if (this.accounts.length && !this.accountId) this.accountId = this.accounts[0].id;
      this.renderAccounts();
    } catch (err) {
      this.accounts = [];
      this.renderAccounts();
      this.setStatus(this.searchStatus, this.errText(err), 'error');
    }
  }

  private renderAccounts(): void {
    if (!this.accounts.length) {
      setHidden(this.accountRow, false);
      setHidden(this.accountSelect, true);
      setHidden(this.accountSingle, false);
      setText(this.accountSingle, tr('nenhuma conta com chave do Frinus neste computador'));
      this.accountSingle.classList.add('is-empty');
      return;
    }
    this.accountSingle.classList.remove('is-empty');
    setHidden(this.accountRow, false);
    if (this.accounts.length === 1) {
      setHidden(this.accountSelect, true);
      setHidden(this.accountSingle, false);
      setText(this.accountSingle, this.accountLabel(this.accounts[0]));
      return;
    }
    setHidden(this.accountSingle, true);
    setHidden(this.accountSelect, false);
    this.accountSelect.replaceChildren(
      ...this.accounts.map((a) => h('option', { attrs: { value: a.id, selected: a.id === this.accountId }, text: this.accountLabel(a) })),
    );
    this.accountSelect.value = this.accountId;
  }

  private accountLabel(a: AccountSummary): string {
    return a.organization ? `${a.organization} — ${a.label}` : a.label;
  }

  private onAccountChange(): void {
    this.accountId = this.accountSelect.value;
    // Troca de conta: os resultados em tela são de outra conta; limpa para evitar confusão.
    this.searchResults.replaceChildren();
    this.tasksList.replaceChildren();
    setText(this.searchStatus, '');
    setText(this.tasksStatus, '');
  }

  // ---------------------------------------------------------------- busca

  private async runSearch(): Promise<void> {
    const query = this.searchInput.value.trim();
    if (!query) {
      this.setStatus(this.searchStatus, tr('digite o que procurar'), 'error');
      return;
    }
    if (!this.accountId) {
      this.setStatus(this.searchStatus, tr('nenhuma conta com chave do Frinus neste computador'), 'error');
      return;
    }
    this.searchResults.replaceChildren();
    this.setStatus(this.searchStatus, tr('buscando…'), 'busy');
    try {
      const r = await apiPost<{ results: MemoryResult[]; count: number }>('/api/frinus/memory/search', { account: this.accountId, query, limit: 15 });
      if (!r.results.length) {
        this.setStatus(this.searchStatus, tr('nenhuma memória encontrada para “{0}”.', [query]), 'empty');
        return;
      }
      this.setStatus(this.searchStatus, tr('{0} resultado(s).', [r.count]), 'ok');
      this.searchResults.replaceChildren(...r.results.map((m) => this.resultItem(m)));
    } catch (err) {
      this.setStatus(this.searchStatus, this.errText(err), 'error');
    }
  }

  private resultItem(m: MemoryResult): HTMLElement {
    const importancePct = Math.round((Number(m.importance) || 0) * 100);
    const meta = h('div', { class: 'ui-mem-result__meta' });
    meta.append(h('span', { class: `ui-mem-chip ui-mem-chip--${m.memory_type}`, text: typeLabel(m.memory_type) }));
    meta.append(h('span', { class: 'ui-mem-imp', title: tr('Importância'), text: tr('importância {0}%', [importancePct]) }));
    const date = shortDate(m.created_at);
    if (date) meta.append(h('span', { class: 'ui-mem-date', text: date }));
    if (typeof m.similarity === 'number') meta.append(h('span', { class: 'ui-mem-sim', title: tr('Semelhança com a busca'), text: `~${Math.round(m.similarity * 100)}%` }));

    const children: (Node | false)[] = [meta, h('p', { class: 'ui-mem-result__content', text: m.content })];
    if (m.context_path) {
      children.push(h('p', { class: 'ui-mem-path', title: tr('Caminho na hierarquia'), text: m.context_path }));
    }
    return h('li', { class: 'ui-mem-result' }, ...children.filter(Boolean) as Node[]);
  }

  // ---------------------------------------------------------------- tarefas

  private async loadTasks(): Promise<void> {
    await this.ensureAccounts();
    if (!this.accountId) {
      this.setStatus(this.tasksStatus, tr('nenhuma conta com chave do Frinus neste computador'), 'error');
      return;
    }
    this.tasksList.replaceChildren();
    this.setStatus(this.tasksStatus, tr('carregando…'), 'busy');
    try {
      const r = await apiGet<{ tasks: TaskRow[]; total: number }>(`/api/frinus/tasks?account=${encodeURIComponent(this.accountId)}`);
      if (!r.tasks.length) {
        this.setStatus(this.tasksStatus, tr('nenhuma tarefa.'), 'empty');
        return;
      }
      this.setStatus(this.tasksStatus, tr('{0} tarefa(s).', [r.total]), 'ok');
      this.tasksList.replaceChildren(...r.tasks.map((t) => this.taskItem(t)));
    } catch (err) {
      this.setStatus(this.tasksStatus, this.errText(err), 'error');
    }
  }

  private taskItem(t: TaskRow): HTMLElement {
    const head = h('div', { class: 'ui-mem-task__head' },
      h('span', { class: `ui-mem-tstatus ui-mem-tstatus--${t.status}`, text: t.status }),
      h('span', { class: 'ui-mem-task__title', text: t.title }),
    );
    const date = shortDate(t.created_at);
    return h('li', { class: 'ui-mem-task' }, head, date ? h('span', { class: 'ui-mem-date', text: date }) : '');
  }

  // ---------------------------------------------------------------- utilidades

  private setStatus(el: HTMLElement, text: string, kind: 'ok' | 'error' | 'busy' | 'empty'): void {
    setText(el, text);
    el.className = `ui-mem-status is-${kind}`;
    this.ctx.announce(text);
  }

  private errText(err: unknown): string {
    return err instanceof Error && err.message ? err.message : tr('não foi possível concluir a busca');
  }
}
