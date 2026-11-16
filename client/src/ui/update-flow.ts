// Fluxo de "Atualizar Córtex", compartilhado pela versão na barra do topo (ui/version.ts) e pela seção "Versão" do
// Sobre (Configurações). Reinstala a versão nova e reinicia o serviço — e isso FECHA as sessões abertas, então sempre
// passa por uma confirmação que lista os trabalhos que serão interrompidos, com a opção de esperar eles terminarem.
//
// Em dry-run (FRINUS_CORTEX_UPDATE_DRYRUN no servidor) o POST devolve só o plano: mostra o que FARIA, sem instalar nem
// reiniciar. De verdade, mostra "Atualizando…" e recarrega a página quando o Córtex volta.
import type { Notice } from '../../../shared/types';
import type { UiContext } from './context';
import { h } from './dom';
import { tr } from '../../../shared/i18n';

interface UpdateApplyResult {
  started: boolean;
  plan: { steps: string[]; command?: { file: string; args: string[] }; manual?: string; service?: string; dryRun: boolean; restarts: boolean };
}

interface OpenJob {
  name: string;
  project: string;
  account: string;
}

/** Trabalhos abertos (agentes principais do Claude Code) a partir do snapshot do escritório. */
function openJobs(ctx: UiContext): OpenJob[] {
  const snap = ctx.store.snapshot;
  if (!snap) return [];
  const roomName = new Map(snap.rooms.map((r) => [r.id, r.name]));
  return snap.agents
    .filter((a) => a.kind === 'main' && (a.provider ?? 'claude') === 'claude')
    .map((a) => ({ name: a.name, project: roomName.get(a.roomId) ?? '', account: a.account }));
}

export class UpdateFlow {
  private updating = false;
  /** Espera os trabalhos terminarem para atualizar: função que cancela a espera (ou null). */
  private waitOff: (() => void) | null = null;

  constructor(
    private readonly ctx: UiContext,
    private readonly toast: (n: Notice) => void,
  ) {}

  get isWaiting(): boolean {
    return !!this.waitOff;
  }

  /** Abre a confirmação (lista os trabalhos que serão fechados). Ponto de entrada da barra do topo e do Sobre. */
  start(): void {
    if (this.updating) return;
    if (this.waitOff) {
      this.cancelWait();
      return;
    }
    this.openConfirm();
  }

  private cancelWait(): void {
    this.waitOff?.();
    this.waitOff = null;
    this.ctx.announce(tr('Espera cancelada.'));
  }

  private openConfirm(): void {
    const jobs = openJobs(this.ctx);
    const info = versionLatest(this.ctx);
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (dlg.open) dlg.close();
      dlg.remove();
    };

    const list = jobs.length
      ? h('ul', { class: 'ui-perf__killlist' }, ...jobs.map((j) => h('li', {}, h('strong', { text: j.name }), h('span', { text: ` — ${j.project} · ${j.account}` }))))
      : h('p', { class: 'ui-perf__confirm-hint', text: tr('Nenhum trabalho aberto agora: nada será interrompido.') });

    const doNow = h('button', { class: 'ui-btn ui-btn--danger', type: 'button', text: tr('Atualizar e reiniciar'), on: { click: () => { finish(); void this.applyUpdate(); } } });
    const actions: HTMLElement[] = [h('button', { class: 'ui-btn', type: 'button', text: tr('Cancelar'), on: { click: () => finish() } })];
    if (jobs.length) {
      actions.push(
        h('button', {
          class: 'ui-btn',
          type: 'button',
          text: tr('Atualizar quando esvaziar'),
          on: { click: () => { this.startWaitForEmpty(); finish(); } },
        }),
      );
    }
    actions.push(doNow);

    const title = info && info !== versionCurrent(this.ctx) ? tr('Atualizar para a v{0}?', [info]) : tr('Atualizar o Frinus Córtex?');
    const dlg = h(
      'dialog',
      { class: 'ui-dialog ui-perf-confirm ui-perf-update', attrs: { 'aria-labelledby': 'ui-upd-title' } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { text: title, attrs: { id: 'ui-upd-title' } })),
      h(
        'div',
        { class: 'ui-perf-confirm__body' },
        h('p', { class: 'ui-perf__confirm-msg', text: jobs.length ? tr('Para atualizar, o Córtex reinicia — e isso INTERROMPE os trabalhos abaixo. Eles podem ser retomados depois.') : tr('O Córtex vai reiniciar para instalar a versão nova. A página volta sozinha quando terminar.') }),
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

  /** Liga a espera: quando não houver mais trabalhos abertos, atualiza. */
  private startWaitForEmpty(): void {
    this.waitOff?.();
    const check = (): void => {
      if (this.updating) return;
      if (openJobs(this.ctx).length === 0) {
        this.cancelWaitSilently();
        void this.applyUpdate();
      }
    };
    const off = this.ctx.store.on('snapshot', check);
    this.waitOff = off;
    this.ctx.announce(tr('Vai atualizar quando os trabalhos terminarem.'));
    this.toast({ id: `upd-wait-${Date.now()}`, level: 'info', at: Date.now(), text: tr('Atualização agendada: vai rodar quando não houver mais trabalhos abertos.') });
    check(); // talvez já esteja vazio
  }

  private cancelWaitSilently(): void {
    this.waitOff?.();
    this.waitOff = null;
  }

  /** Dispara POST /api/updates/apply. No dry-run só mostra o que FARIA; de verdade, mostra "Atualizando…" e recarrega. */
  async applyUpdate(): Promise<void> {
    if (this.updating) return;
    this.updating = true;
    let result: UpdateApplyResult;
    try {
      // Content-Type JSON é exigido como barreira contra CSRF (ver server/http/guard.ts), mesmo sem corpo.
      const res = await fetch('/api/updates/apply', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = (await res.json().catch(() => null)) as (UpdateApplyResult & { error?: string }) | null;
      if (!res.ok || !body) throw new Error(body?.error ?? tr('erro {0}', [res.status]));
      result = body;
    } catch (err) {
      this.updating = false;
      this.toast({ id: `upd-${Date.now()}`, level: 'warn', at: Date.now(), text: tr('Não deu para atualizar: {0}', [(err as Error).message]) });
      return;
    }

    if (result.plan.manual) {
      this.updating = false;
      this.toast({ id: `upd-${Date.now()}`, level: 'info', at: Date.now(), text: result.plan.manual });
      return;
    }
    if (result.plan.dryRun || !result.started) {
      this.updating = false;
      this.showDryRun(result);
      return;
    }
    this.showUpdatingOverlay();
    void this.pollUntilBack();
  }

  private showDryRun(result: UpdateApplyResult): void {
    const steps = result.plan.steps.map((s) => h('li', { text: s }));
    const close = h('button', { class: 'ui-btn', type: 'button', text: tr('Entendi') });
    const dlg = h(
      'dialog',
      { class: 'ui-dialog ui-perf-confirm', attrs: { 'aria-labelledby': 'ui-upd-dry-title' } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { text: tr('Simulação — nada foi alterado'), attrs: { id: 'ui-upd-dry-title' } })),
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
    document.getElementById('ui-perf-updating')?.remove();
    this.updating = false;
    this.toast({ id: `upd-${Date.now()}`, level: 'warn', at: Date.now(), text: tr('O Córtex está demorando a voltar. Recarregue a página em instantes.') });
  }
}

function versionCurrent(ctx: UiContext): string | undefined {
  const v = ctx.store.liveSnapshot?.meta.version;
  return v && /^\d+\.\d+\.\d+/.test(v) ? v : undefined;
}

function versionLatest(ctx: UiContext): string | undefined {
  return ctx.store.liveSnapshot?.meta.updates?.latest;
}
