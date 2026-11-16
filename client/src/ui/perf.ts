// Painel "Desempenho": uma pílula sempre visível na barra do topo com o semáforo da máquina (🟢🟡🔴) que abre a janela
// com a frase leiga, três medidores (Memória, Processador, Folga para abrir trabalho) e a lista de sessões com o peso
// de cada uma. Os números vêm de GET /api/perf (ui/perf-model.ts cuida dos rótulos e cálculos puros).
//
// Também é a "trava gentil" de abrir trabalho: no amarelo um aviso que não bloqueia; no vermelho uma confirmação
// ("Abrir mesmo assim"). Nunca impede nem encerra nada sozinho — pausar ou fechar é sempre um clique do usuário.
import type { Notice, PerfSnapshot } from '../../../shared/types';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setAttr, setHidden, setText, setVariant } from './dom';
import { ICONS } from './icons';
import {
  barPct,
  cpuMeter,
  formatMb,
  freeMeter,
  freeText,
  heaviestSession,
  levelAria,
  levelLabel,
  memMeter,
  weightLabel,
  type MeterState,
} from './perf-model';
import { versionInfo } from './version';
import { tr } from '../../../shared/i18n';

const POLL_MS = 3_000;

/** Plano devolvido por POST /api/updates/apply. */
interface UpdateApplyResult {
  started: boolean;
  plan: { steps: string[]; command?: { file: string; args: string[] }; manual?: string; service?: string; dryRun: boolean; restarts: boolean };
}

async function getPerf(signal: AbortSignal): Promise<PerfSnapshot> {
  const res = await fetch('/api/perf', { cache: 'no-store', signal });
  const body = (await res.json().catch(() => null)) as (PerfSnapshot & { error?: string }) | null;
  if (!res.ok || !body) throw new Error(body?.error ?? tr('erro {0}', [res.status]));
  return body;
}

export class PerfWidget implements UiComponent {
  /** Pílula do semáforo, posta na linha de status da marca (barra do topo). */
  readonly pill: HTMLButtonElement;
  private readonly pillDot: HTMLElement;
  private readonly pillText: HTMLElement;
  readonly el: HTMLDialogElement; // janela

  private snap: PerfSnapshot | null = null;
  private error = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: AbortController | null = null;
  private opener: HTMLElement | null = null;

  // elementos da janela reaproveitados entre renderizações
  private readonly summary: HTMLElement;
  private readonly summaryDot: HTMLElement;
  private readonly meters: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly sessionList: HTMLElement;
  private readonly details: HTMLElement;
  private readonly status: HTMLElement;
  // Rodapé: versão do Córtex + "Atualizar Córtex".
  private readonly footVer: HTMLElement;
  private readonly updateBtn: HTMLButtonElement;
  private readonly updateNote: HTMLElement;
  /** Quando ligado: aplica a atualização assim que não houver trabalhos abertos. */
  private pendingWhenEmpty = false;
  private updating = false;

  constructor(
    private readonly ctx: UiContext,
    private readonly toast: (n: Notice) => void,
  ) {
    this.pillDot = h('span', { class: 'ui-perfpill__dot', attrs: { 'aria-hidden': 'true' } });
    this.pillText = h('span', { class: 'ui-perfpill__text' });
    this.pill = h(
      'button',
      { class: 'ui-perfpill', type: 'button', attrs: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, on: { click: () => this.toggle() } },
      this.pillDot,
      this.pillText,
    );

    this.summaryDot = h('span', { class: 'ui-perf__bigdot', attrs: { 'aria-hidden': 'true' } });
    this.summary = h('p', { class: 'ui-perf__summary' });
    this.meters = h('div', { class: 'ui-perf__meters' });
    this.banner = h('div', { class: 'ui-perf__banner', role: 'alert', hidden: true });
    this.sessionList = h('ul', { class: 'ui-perf__sessions', attrs: { 'aria-label': tr('Trabalhos abertos') } });
    this.details = h('div', { class: 'ui-perf__detail-grid' });
    this.status = h('p', { class: 'ui-perf__status', hidden: true });

    this.footVer = h('span', { class: 'ui-perf__foot-ver' });
    this.updateBtn = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Atualizar Córtex'), on: { click: () => void this.onUpdateClick() } });
    this.updateNote = h('span', { class: 'ui-perf__foot-note', hidden: true });

    const close = iconButton(ICONS.close, tr('Fechar (Esc)'), () => this.close(), 'ui-icon-btn--sm');
    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-perf', attrs: { 'aria-labelledby': 'ui-perf-title' } },
      h(
        'div',
        { class: 'ui-dialog__head ui-perf__head' },
        h('h2', { text: tr('Desempenho'), attrs: { id: 'ui-perf-title' } }),
        close,
      ),
      h(
        'div',
        { class: 'ui-perf__body' },
        h('div', { class: 'ui-perf__summaryline' }, this.summaryDot, this.summary),
        this.status,
        this.banner,
        this.meters,
        h('h3', { class: 'ui-perf__subtitle', text: tr('Trabalhos abertos') }),
        this.sessionList,
        h('details', { class: 'ui-perf__details' }, h('summary', { text: tr('Detalhes (números crus)') }), this.details),
        h('div', { class: 'ui-perf__foot' }, this.footVer, h('div', { class: 'ui-perf__foot-right' }, this.updateNote, this.updateBtn)),
      ),
    );
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this.el.addEventListener('close', () => this.onClosed());

    // A pílula precisa do semáforo desde o começo: busca já e segue de 3 em 3 s enquanto a aba está à vista.
    void this.refresh();
    this.startTimer();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stopTimer();
      else {
        void this.refresh();
        this.startTimer();
      }
    });
  }

  // --------------------------------------------------------------------------------------- abrir / fechar a janela
  get isOpen(): boolean {
    return this.el.open;
  }

  open(): void {
    if (this.el.open) return;
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.el.showModal();
    this.pill.setAttribute('aria-expanded', 'true');
    this.renderPanel();
    void this.refresh();
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  toggle(): void {
    if (this.el.open) this.close();
    else this.open();
  }

  private onClosed(): void {
    this.pill.setAttribute('aria-expanded', 'false');
    if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
    this.opener = null;
  }

  // --------------------------------------------------------------------------------------------------- polling
  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async refresh(): Promise<void> {
    this.inflight?.abort();
    const ac = new AbortController();
    this.inflight = ac;
    try {
      const snap = await getPerf(ac.signal);
      if (ac.signal.aborted) return;
      this.snap = snap;
      this.error = false;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      this.error = true;
    } finally {
      if (this.inflight === ac) this.inflight = null;
    }
    this.renderPill();
    if (this.el.open) this.renderPanel();
    // "Atualizar quando esvaziar": dispara assim que não houver mais trabalhos abertos.
    if (this.pendingWhenEmpty && !this.updating && this.snap && this.snap.sessions.length === 0) {
      this.pendingWhenEmpty = false;
      void this.applyUpdate();
    }
  }

  // --------------------------------------------------------------------------------------------------- render
  render(): void {
    // Chamado uma vez por quadro pela UI; a pílula já se atualiza no polling, mas mantém o rótulo coerente.
    this.renderPill();
  }

  private renderPill(): void {
    const level = this.snap?.level ?? 'green';
    setVariant(this.pill, 'is-', this.error && !this.snap ? 'off' : level);
    setText(this.pillText, this.error && !this.snap ? tr('Desempenho') : levelLabel(level));
    setAttr(this.pill, 'aria-label', this.snap ? levelAria(level) : tr('Desempenho da máquina'));
    setAttr(this.pill, 'title', this.snap?.summary ?? tr('Desempenho da máquina'));
  }

  private renderPanel(): void {
    const snap = this.snap;
    setHidden(this.status, !(this.error && !snap));
    if (this.error && !snap) setText(this.status, tr('Não deu para ler o desempenho agora. Tentando de novo…'));
    if (!snap) return;

    setVariant(this.summaryDot, 'is-', snap.level);
    setText(this.summary, snap.summary);

    // Medidores.
    this.meters.replaceChildren(
      meter(tr('Memória'), Math.round(snap.system.ramUsedPct), '%', barPct(snap.system.ramUsedPct, 100), memMeter(snap.system.ramUsedPct)),
      meter(tr('Processador'), Math.round(snap.system.cpuPct), '%', barPct(snap.system.cpuPct, 100), cpuMeter(snap.system.cpuPct)),
      meterText(tr('Folga para abrir trabalho'), freeText(snap.budget.freeSessions), barPct(Math.max(0, snap.budget.freeSessions), snap.budget.sessionsMax), freeMeter(snap.budget.freeSessions)),
    );

    // Banner vermelho: nomeia a sessão mais pesada e sugere pausá-la/fechá-la (ação só com clique).
    const heavy = snap.level === 'red' ? heaviestSession(snap) : undefined;
    setHidden(this.banner, !heavy);
    if (heavy) {
      const go = h('button', {
        class: 'ui-perf__banner-btn',
        type: 'button',
        text: tr('Ir até esse trabalho'),
        on: { click: () => this.goToSession(heavy.account, heavy.pid) },
      });
      this.banner.replaceChildren(
        h('span', { text: tr('O trabalho “{0}” ({1}) está pesado ({2}). Pausar ou fechar esse ajuda a desafogar.', [heavy.name, heavy.project, formatMb(heavy.memMb)]) }),
        go,
      );
    }

    // Lista de sessões (ordenadas por memória pelo servidor). A mais pesada em destaque.
    const scale = Math.max(1200, snap.sessions[0]?.memMb ?? 0); // barra relativa ao teto "pesado" ou à maior sessão
    this.sessionList.replaceChildren(
      ...(snap.sessions.length
        ? snap.sessions.map((s) => sessionRow(s, scale, s.pid === snap.heaviestPid))
        : [h('li', { class: 'ui-perf__empty', text: tr('Nenhum trabalho aberto no momento.') })]),
    );

    // Detalhes crus.
    const sys = snap.system;
    const rows: [string, string][] = [
      [tr('Plataforma'), platformLabel(snap.platform)],
      [tr('Memória em uso'), `${formatMb(sys.ramUsedMb)} / ${formatMb(sys.ramTotalMb)} (${Math.round(sys.ramUsedPct)}%)`],
      [tr('Memória livre'), formatMb(sys.ramAvailableMb)],
      [tr('Swap em uso'), sys.swapTotalMb ? `${formatMb(sys.swapUsedMb)} / ${formatMb(sys.swapTotalMb)}` : tr('sem swap')],
      [tr('Processador'), tr('{0}% de {1} núcleos', [Math.round(sys.cpuPct), sys.cpuCount])],
    ];
    if (sys.psiMemAvg10 !== undefined) rows.push([tr('Pressão de memória (PSI avg10)'), sys.psiMemAvg10.toFixed(1)]);
    if (sys.psiCpuAvg10 !== undefined) rows.push([tr('Pressão de processador (PSI avg10)'), sys.psiCpuAvg10.toFixed(1)]);
    if (snap.cortex.currentMb !== undefined) {
      const limit = snap.cortex.highMb ?? snap.cortex.maxMb;
      rows.push([tr('Teto do Córtex (cgroup)'), limit != null ? `${formatMb(snap.cortex.currentMb)} / ${formatMb(limit)}` : tr('{0} (sem limite)', [formatMb(snap.cortex.currentMb)])]);
    }
    rows.push([tr('Orçamento de trabalhos'), tr('{0} de {1} em uso', [snap.budget.sessionsActive, snap.budget.sessionsMax])]);
    rows.push([tr('Reserva do sistema'), formatMb(snap.budget.reserveMb)]);
    this.details.replaceChildren(
      ...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]),
    );

    this.renderFoot();
  }

  /** Rodapé: versão do Córtex e o botão "Atualizar Córtex". */
  private renderFoot(): void {
    const info = versionInfo(this.ctx.store.liveSnapshot);
    const version = info?.version;
    const latest = info?.updates?.latest;
    const upToDate = !!info?.updates && info.updates.state === 'ok' && info.updates.available === false && (!latest || latest === version);
    setText(
      this.footVer,
      version ? (latest && latest !== version ? tr('Frinus Córtex v{0} · nova: v{1}', [version, latest]) : tr('Frinus Córtex v{0}', [version])) : tr('Frinus Córtex'),
    );
    if (this.updating) {
      this.updateBtn.disabled = true;
      setText(this.updateBtn, tr('Atualizando…'));
      setHidden(this.updateNote, true);
      return;
    }
    if (this.pendingWhenEmpty) {
      this.updateBtn.disabled = false;
      setText(this.updateBtn, tr('Cancelar espera'));
      setHidden(this.updateNote, false);
      setText(this.updateNote, tr('Vai atualizar quando os trabalhos terminarem.'));
      return;
    }
    setText(this.updateBtn, tr('Atualizar Córtex'));
    this.updateBtn.disabled = upToDate;
    setHidden(this.updateNote, !upToDate);
    if (upToDate) setText(this.updateNote, tr('Você já está na versão mais recente.'));
  }

  private goToSession(account: string, pid: number): void {
    const id = `${account}:${pid}`;
    if (this.ctx.agent(id)) {
      this.close();
      this.ctx.select({ type: 'agent', id }, { focus: true });
    } else {
      this.ctx.announce(tr('Esse trabalho já saiu do córtex.'));
    }
  }

  // ------------------------------------------------------------------------------------ trava gentil de abrir trabalho
  /**
   * Consultada antes de abrir uma sessão nova. 🟢 segue direto; 🟡 avisa sem bloquear e segue; 🔴 pede confirmação
   * explícita. Nunca bloqueia no 🟡 nem encerra nada — a decisão é sempre do usuário.
   */
  async confirmOpen(): Promise<boolean> {
    const snap = this.snap;
    const level = snap?.level ?? 'green';
    if (level === 'green' || !snap) return true;
    if (level === 'yellow') {
      this.toast({ id: `perf-${Date.now()}`, level: 'warn', at: Date.now(), text: tr('A máquina está começando a encher. Dá para abrir, mas evite outro trabalho pesado agora.') });
      return true;
    }
    return this.askConfirm(snap);
  }

  private askConfirm(snap: PerfSnapshot): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const heavy = heaviestSession(snap);
      let done = false;
      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        if (dlg.open) dlg.close();
        dlg.remove();
        resolve(ok);
      };
      const proceed = h('button', { class: 'ui-btn ui-btn--danger', type: 'button', text: tr('Abrir mesmo assim'), on: { click: () => finish(true) } });
      const cancel = h('button', { class: 'ui-btn', type: 'button', text: tr('Cancelar'), on: { click: () => finish(false) } });
      const lines: HTMLElement[] = [
        h('p', { class: 'ui-perf__confirm-msg', text: tr('A máquina está sobrecarregada agora. Abrir mais um trabalho pode deixar tudo lento.') }),
      ];
      if (heavy) lines.push(h('p', { class: 'ui-perf__confirm-hint', text: tr('Mais pesado: “{0}” ({1}), {2}.', [heavy.name, heavy.project, formatMb(heavy.memMb)]) }));
      const dlg = h(
        'dialog',
        { class: 'ui-dialog ui-perf-confirm', attrs: { 'aria-labelledby': 'ui-perf-confirm-title' } },
        h('div', { class: 'ui-dialog__head' }, h('h2', { text: tr('Máquina sobrecarregada'), attrs: { id: 'ui-perf-confirm-title' } })),
        h('div', { class: 'ui-perf-confirm__body' }, ...lines, h('div', { class: 'ui-perf-confirm__actions' }, cancel, proceed)),
      );
      dlg.addEventListener('cancel', (e) => {
        e.preventDefault();
        finish(false);
      });
      dlg.addEventListener('keydown', (e) => e.stopPropagation());
      this.ctx.root.append(dlg);
      dlg.showModal();
      cancel.focus();
    });
  }

  // ----------------------------------------------------------------------------------------- Atualizar Córtex
  private async onUpdateClick(): Promise<void> {
    if (this.updating) return;
    if (this.pendingWhenEmpty) {
      this.pendingWhenEmpty = false;
      this.renderFoot();
      this.ctx.announce(tr('Espera cancelada.'));
      return;
    }
    this.openUpdateConfirm();
  }

  /** Diálogo que LISTA os trabalhos que serão fechados antes de atualizar e reiniciar. */
  private openUpdateConfirm(): void {
    const sessions = this.snap?.sessions ?? [];
    const info = versionInfo(this.ctx.store.liveSnapshot);
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (dlg.open) dlg.close();
      dlg.remove();
    };

    const list = sessions.length
      ? h(
          'ul',
          { class: 'ui-perf__killlist' },
          ...sessions.map((s) => h('li', {}, h('strong', { text: s.name }), h('span', { text: ` — ${s.project} · ${s.account}` }))),
        )
      : h('p', { class: 'ui-perf__confirm-hint', text: tr('Nenhum trabalho aberto agora: nada será interrompido.') });

    const doNow = h('button', { class: 'ui-btn ui-btn--danger', type: 'button', text: tr('Atualizar e reiniciar'), on: { click: () => { finish(); void this.applyUpdate(); } } });
    const actions: HTMLElement[] = [h('button', { class: 'ui-btn', type: 'button', text: tr('Cancelar'), on: { click: () => finish() } })];
    if (sessions.length) {
      actions.push(h('button', { class: 'ui-btn', type: 'button', text: tr('Atualizar quando esvaziar'), on: { click: () => { this.pendingWhenEmpty = true; this.renderFoot(); finish(); this.ctx.announce(tr('Vai atualizar quando os trabalhos terminarem.')); } } }));
    }
    actions.push(doNow);

    const title = info?.updates?.latest && info.updates.latest !== info.version ? tr('Atualizar para a v{0}?', [info.updates.latest]) : tr('Atualizar o Frinus Córtex?');
    const dlg = h(
      'dialog',
      { class: 'ui-dialog ui-perf-confirm ui-perf-update', attrs: { 'aria-labelledby': 'ui-perf-update-title' } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { text: title, attrs: { id: 'ui-perf-update-title' } })),
      h(
        'div',
        { class: 'ui-perf-confirm__body' },
        h('p', { class: 'ui-perf__confirm-msg', text: sessions.length ? tr('Para atualizar, o Córtex reinicia — e isso INTERROMPE os trabalhos abaixo. Eles podem ser retomados depois.') : tr('O Córtex vai reiniciar para instalar a versão nova. A página volta sozinha quando terminar.') }),
        list,
        h('div', { class: 'ui-perf-confirm__actions' }, ...actions),
      ),
    );
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(); });
    dlg.addEventListener('keydown', (e) => e.stopPropagation());
    this.ctx.root.append(dlg);
    dlg.showModal();
    actions[0].focus();
  }

  /** Dispara POST /api/updates/apply. No dry-run só mostra o que FARIA; de verdade, mostra "Atualizando…" e recarrega. */
  private async applyUpdate(): Promise<void> {
    if (this.updating) return;
    this.updating = true;
    this.renderFoot();
    let result: UpdateApplyResult;
    try {
      // Content-Type JSON é exigido como barreira contra CSRF (ver server/http/guard.ts), mesmo sem corpo.
      const res = await fetch('/api/updates/apply', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = (await res.json().catch(() => null)) as (UpdateApplyResult & { error?: string }) | null;
      if (!res.ok || !body) throw new Error(body?.error ?? tr('erro {0}', [res.status]));
      result = body;
    } catch (err) {
      this.updating = false;
      this.renderFoot();
      this.toast({ id: `perf-upd-${Date.now()}`, level: 'warn', at: Date.now(), text: tr('Não deu para atualizar: {0}', [(err as Error).message]) });
      return;
    }

    if (result.plan.manual) {
      this.updating = false;
      this.renderFoot();
      this.toast({ id: `perf-upd-${Date.now()}`, level: 'info', at: Date.now(), text: result.plan.manual });
      return;
    }
    if (result.plan.dryRun || !result.started) {
      // Simulação: nada foi instalado nem reiniciado. Mostra os passos que seriam executados.
      this.updating = false;
      this.renderFoot();
      this.showDryRun(result);
      return;
    }
    // De verdade: o servidor vai reiniciar. Mostra o aviso e recarrega quando voltar.
    this.showUpdatingOverlay();
    void this.pollUntilBack();
  }

  private showDryRun(result: UpdateApplyResult): void {
    const steps = result.plan.steps.map((s) => h('li', { text: s }));
    const close = h('button', { class: 'ui-btn', type: 'button', text: tr('Entendi') });
    const dlg = h(
      'dialog',
      { class: 'ui-dialog ui-perf-confirm', attrs: { 'aria-labelledby': 'ui-perf-dry-title' } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { text: tr('Simulação — nada foi alterado'), attrs: { id: 'ui-perf-dry-title' } })),
      h(
        'div',
        { class: 'ui-perf-confirm__body' },
        h('p', { class: 'ui-perf__confirm-msg', text: tr('O modo de teste está ligado (FRINUS_CORTEX_UPDATE_DRYRUN). Estes passos SERIAM executados:') }),
        h('ol', { class: 'ui-perf__drysteps' }, ...steps),
        result.plan.command ? h('p', { class: 'ui-perf__confirm-hint', text: `${result.plan.command.file} ${result.plan.command.args.join(' ')}` }) : null,
        h('div', { class: 'ui-perf-confirm__actions' }, close),
      ),
    );
    close.addEventListener('click', () => { if (dlg.open) dlg.close(); dlg.remove(); });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (dlg.open) dlg.close(); dlg.remove(); });
    dlg.addEventListener('keydown', (e) => e.stopPropagation());
    this.ctx.root.append(dlg);
    dlg.showModal();
    close.focus();
  }

  private showUpdatingOverlay(): void {
    const overlay = h(
      'div',
      { class: 'ui-perf-updating', attrs: { role: 'status', 'aria-live': 'polite' } },
      h('div', { class: 'ui-perf-updating__card' }, h('div', { class: 'ui-perf-updating__spin', attrs: { 'aria-hidden': 'true' } }), h('p', { text: tr('Atualizando o Frinus Córtex… a página volta sozinha quando terminar.') })),
    );
    overlay.id = 'ui-perf-updating';
    this.ctx.root.append(overlay);
  }

  /** Espera o servidor voltar depois do reinício e recarrega a página. */
  private async pollUntilBack(): Promise<void> {
    const start = Date.now();
    let wentDown = false;
    while (Date.now() - start < 180_000) {
      await new Promise((r) => setTimeout(r, 2000));
      let ok = false;
      try {
        const res = await fetch('/api/updates', { cache: 'no-store' });
        ok = res.ok;
      } catch {
        ok = false;
      }
      if (!ok) wentDown = true;
      else if (wentDown) {
        location.reload();
        return;
      }
    }
    // Não voltou a tempo: tira o aviso para a pessoa poder recarregar à mão.
    document.getElementById('ui-perf-updating')?.remove();
    this.updating = false;
    this.toast({ id: `perf-upd-${Date.now()}`, level: 'warn', at: Date.now(), text: tr('O Córtex está demorando a voltar. Recarregue a página em instantes.') });
  }
}

/** Medidor numérico (memória, processador): rótulo + barra + valor com unidade. */
function meter(label: string, value: number, unit: string, pct: number, state: MeterState): HTMLElement {
  return meterText(label, `${value}${unit}`, pct, state);
}

/** Medidor com valor em texto (usado pela folga). */
function meterText(label: string, valueText: string, pct: number, state: MeterState): HTMLElement {
  const bar = h('span', { class: 'ui-perf__bar-fill' });
  bar.style.width = `${pct}%`;
  const track = h('span', { class: `ui-perf__bar is-${state}`, attrs: { role: 'presentation' } }, bar);
  return h(
    'div',
    { class: 'ui-perf__meter', attrs: { 'aria-label': `${label}: ${valueText}` } },
    h('div', { class: 'ui-perf__meter-top' }, h('span', { class: 'ui-perf__meter-label', text: label }), h('span', { class: 'ui-perf__meter-value', text: valueText })),
    track,
  );
}

/** Uma linha da lista de sessões: nome/projeto/conta, barra de peso e rótulo. */
function sessionRow(s: PerfSnapshot['sessions'][number], scale: number, heaviest: boolean): HTMLElement {
  const bar = h('span', { class: 'ui-perf__bar-fill' });
  bar.style.width = `${barPct(s.memMb, scale)}%`;
  const weightClass = s.weight === 'heavy' ? 'bad' : s.weight === 'medium' ? 'warn' : 'ok';
  const cpu = s.cpuPct !== undefined ? tr(' · {0}% CPU', [s.cpuPct]) : '';
  return h(
    'li',
    { class: `ui-perf__session${heaviest ? ' is-heaviest' : ''}` },
    h(
      'div',
      { class: 'ui-perf__session-head' },
      h('span', { class: 'ui-perf__session-name', text: s.name }),
      h('span', { class: `ui-perf__weight is-${weightClass}`, text: weightLabel(s.weight) }),
    ),
    h('div', { class: 'ui-perf__session-sub', text: `${s.project} · ${s.account}` }),
    h('div', { class: 'ui-perf__session-barrow' }, h('span', { class: `ui-perf__bar is-${weightClass}` }, bar), h('span', { class: 'ui-perf__session-mem', text: `${formatMb(s.memMb)}${cpu}` })),
  );
}

function platformLabel(p: PerfSnapshot['platform']): string {
  if (p === 'wsl') return tr('Windows (WSL) — a memória é a da máquina virtual do Linux');
  if (p === 'darwin') return tr('macOS');
  if (p === 'linux') return tr('Linux');
  return tr('outro');
}
