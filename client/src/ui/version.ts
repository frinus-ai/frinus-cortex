// Versão do Habblaud: o número na barra superior, o selo "Nova versão" quando o GitHub tem uma release mais
// nova (quem consulta é o servidor, server/updates/checker.ts), o aviso único por versão e a seção "Sobre"
// das configurações (estado da verificação, "Verificar agora", novidades e como atualizar).
import type { Notice, OfficeSnapshot, UpdateStatus } from '../../../shared/types';
import type { UiComponent, UiContext } from './context';
import { h, setAttr, setHidden, setText, setTitle, setVariant } from './dom';
import { formatDateTime, relativeTime } from './format';
import { pixelIcon } from './icons';
import { safeLocalStorage } from './prefs';
import { tr } from '../../../shared/i18n';

/** Última versão nova já avisada neste navegador (o aviso sai uma vez por versão). */
export const UPDATE_SEEN_KEY = 'habblaud:update-seen';

export const VERSION_ICONS = {
  up: pixelIcon(['...##...', '..####..', '.######.', '########', '..####..', '..####..', '..####..', '..####..']),
};

/** Versão em uso e o resultado da verificação, do snapshot ao vivo (no timelapse e no ?mock=1 não há versão real). */
export function versionInfo(snap: OfficeSnapshot | null | undefined): { version: string; updates?: UpdateStatus } | null {
  const v = snap?.meta.version;
  if (!v || !/^\d+\.\d+\.\d+/.test(v)) return null;
  return { version: v, updates: snap.meta.updates };
}

/** Só links do próprio GitHub viram link na página. */
export function safeGithubUrl(url: string | undefined): string | undefined {
  return url && /^https:\/\/github\.com\/[^\s"'<>]+$/.test(url) ? url : undefined;
}

export type UpdateTone = 'new' | 'ok' | 'pending' | 'warn' | 'off';

/** Linha de estado da seção "Sobre". */
export function updateStatusLine(version: string, s: UpdateStatus | undefined, now: number): { tone: UpdateTone; text: string } {
  if (!s) return { tone: 'off', text: tr('Este servidor não verifica versões novas.') };
  const checked = s.checkedAt ? ` · verificado ${relativeTime(s.checkedAt, now)}` : '';
  switch (s.state) {
    case 'off':
      return {
        tone: 'off',
        text: s.repo
          ? tr('Verificação de versão nova desligada (HABBLAUD_UPDATE_CHECK=0).')
          : tr('Verificação de versão nova desligada: o package.json não aponta um repositório no GitHub.'),
      };
    case 'pending':
      return { tone: 'pending', text: tr('Verificando se há versão nova…') };
    case 'error':
      if (s.available && s.latest) return { tone: 'new', text: tr('Nova versão disponível: v{0}. A última verificação falhou ({1}).', [s.latest, s.error ?? tr('erro')]) };
      return { tone: 'warn', text: tr('Não deu para verificar agora: {0}{1}.', [s.error ?? tr('erro desconhecido'), s.checkedAt ? tr(' · última verificação {0}', [relativeTime(s.checkedAt, now)]) : '']) };
    case 'ok':
      if (s.available && s.latest) return { tone: 'new', text: tr('Nova versão disponível: v{0}{1}.', [s.latest, s.publishedAt ? tr(', publicada em {0}', [formatDateTime(s.publishedAt)]) : '']) };
      if (!s.latest) return { tone: 'ok', text: tr('Nenhuma versão publicada no GitHub ainda{0}.', [checked]) };
      if (s.latest !== version) return { tone: 'ok', text: tr('Você está à frente da última versão publicada (v{0}){1}.', [s.latest, checked]) };
      return { tone: 'ok', text: tr('Você está na versão mais recente{0}.', [checked]) };
  }
}

/** Dica do número de versão na barra superior. */
export function versionChipTitle(version: string, s: UpdateStatus | undefined, now: number): string {
  if (s?.available && s.latest) return tr('Nova versão do Córtex: v{0} (você usa a v{1}). Clique para ver as novidades e como atualizar.', [s.latest, version]);
  return tr('Frinus Córtex v{0}. {1} Clique para ver detalhes.', [version, updateStatusLine(version, s, now).text]);
}

/** Número da versão na barra superior; vira o selo "Nova versão" quando há release mais nova. */
export class VersionChip implements UiComponent {
  readonly el: HTMLButtonElement;
  private text: HTMLElement;

  /** Lembra o último estado "tem atualização" para o clique decidir entre abrir o fluxo e abrir o Sobre. */
  private fresh = false;

  constructor(
    private ctx: UiContext,
    private settingsBtn: HTMLElement,
  ) {
    const icon = h('span', { class: 'ui-version__icon', attrs: { 'aria-hidden': 'true' } });
    icon.innerHTML = VERSION_ICONS.up;
    this.text = h('span', { class: 'ui-version__text' });
    // Com versão nova, o clique abre o fluxo de atualização (confirmação + dry-run); sem, leva ao Sobre.
    this.el = h('button', { class: 'ui-version', type: 'button', hidden: true, on: { click: () => (this.fresh && this.ctx.startUpdate ? this.ctx.startUpdate() : this.ctx.openAbout()) } }, icon, this.text);
  }

  render(): void {
    const info = versionInfo(this.ctx.store.liveSnapshot);
    setHidden(this.el, !info);
    const fresh = !!info?.updates?.available && !!info.updates.latest;
    this.fresh = fresh;
    this.settingsBtn.classList.toggle('has-update', fresh);
    const label = fresh ? tr('Configurações (nova versão disponível)') : tr('Configurações');
    setAttr(this.settingsBtn, 'aria-label', label);
    setTitle(this.settingsBtn, label);
    if (!info) return;
    this.el.classList.toggle('is-new', fresh);
    // Com versão nova vira um controle claro: "v{atual} · Atualizar"; sem, só o número discreto.
    setText(this.text, fresh ? tr('v{0} · Atualizar', [info.version]) : `v${info.version}`);
    const title = fresh && info.updates?.latest ? tr('Nova versão v{0} (você usa a v{1}). Clique para atualizar.', [info.updates.latest, info.version]) : versionChipTitle(info.version, info.updates, this.ctx.now());
    setTitle(this.el, title);
    setAttr(this.el, 'aria-label', title);
  }
}

/** Avisa (uma vez por versão, neste navegador) quando aparece uma versão nova. */
export class UpdateToaster implements UiComponent {
  constructor(
    private ctx: UiContext,
    private push: (n: Notice) => void,
  ) {}

  private shown: string | undefined;

  render(): void {
    if (this.ctx.store.connection !== 'open') return;
    const s = versionInfo(this.ctx.store.liveSnapshot)?.updates;
    if (!s?.available || !s.latest || this.shown === s.latest) return;
    this.shown = s.latest;
    const storage = safeLocalStorage();
    try {
      if (storage?.getItem(UPDATE_SEEN_KEY) === s.latest) return;
      storage?.setItem(UPDATE_SEEN_KEY, s.latest);
    } catch {
      // Sem armazenamento: avisa uma vez por página aberta.
    }
    this.push({ id: `update:${s.latest}`, level: 'success', text: tr('Nova versão do Córtex: v{0}. Veja as novidades e como atualizar em Configurações › Sobre.', [s.latest]), at: this.ctx.now() });
  }
}

/** Seção "Sobre" das configurações. */
/** Painel do Frinus (onde fica o instalador do Córtex e a chave de acesso). */
const FRINUS_PANEL_URL = 'https://frinus.rdxsec.com.br/integrations/frinus-cortex';

/**
 * Seção "Sobre" das configurações: o Frinus Córtex, a versão em uso e como atualizar. No Córtex a busca de versão
 * nova no GitHub fica desligada (HABBLAUD_UPDATE_CHECK=0 no cortex.env): atualizar é rodar o instalador de novo.
 */
export class AboutGroup {
  readonly el: HTMLElement;
  private name: HTMLElement;
  private verStatus: HTMLElement;
  private checkBtn: HTMLButtonElement;
  private updateBtn: HTMLButtonElement;
  private updateNote: HTMLElement;
  private checking = false;

  constructor(private ctx: UiContext) {
    this.name = h('strong', { class: 'ui-about__version' });
    const panel = h('a', { class: 'ui-link-btn', text: tr('Abrir o painel do Frinus'), attrs: { href: FRINUS_PANEL_URL, target: '_blank', rel: 'noopener noreferrer' } });

    // Seção "Versão": versão atual, última verificação, "Verificar agora" e "Atualizar Córtex".
    this.verStatus = h('p', { class: 'ui-set__hint ui-about__verstatus' });
    this.checkBtn = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Verificar agora'), on: { click: () => void this.checkNow() } });
    this.updateBtn = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Atualizar Córtex'), on: { click: () => this.ctx.startUpdate?.() } });
    this.updateNote = h('span', { class: 'ui-about__updnote', hidden: true });
    const verSection = h(
      'div',
      { class: 'ui-about__version-sec' },
      h('h4', { class: 'ui-about__subhead', text: tr('Versão') }),
      this.verStatus,
      h('div', { class: 'ui-about__ver-actions' }, this.checkBtn, this.updateBtn, this.updateNote),
    );

    this.el = h(
      'div',
      { class: 'ui-set-group ui-about', attrs: { id: 'ui-about' } },
      h('h3', { text: tr('Sobre'), tabIndex: -1 }),
      h('div', { class: 'ui-about__head' }, h('span', { class: 'ui-about__name' }, 'Frinus Córtex ', this.name)),
      h('p', { class: 'ui-set__hint', text: tr('A interface visual do Frinus: acompanhe seus agentes trabalhando e converse com o Frinus, com a memória da sua empresa, sem abrir o terminal.') }),
      verSection,
      panel,
      h('p', { class: 'ui-set__hint', text: tr('Frinus · RDX Security') }),
    );
  }

  render(): void {
    const info = versionInfo(this.ctx.store.liveSnapshot);
    setHidden(this.name, !info);
    if (info) setText(this.name, `v${info.version}`);

    const updates = info?.updates;
    const latest = updates?.latest;
    const fresh = !!updates?.available && !!latest;
    const upToDate = !!updates && updates.state === 'ok' && updates.available === false && (!latest || latest === info?.version);
    // Linha de estado: usa o texto canônico da verificação (ui/version.ts).
    if (this.checking) setText(this.verStatus, tr('Verificando se há versão nova…'));
    else if (info) setText(this.verStatus, updateStatusLine(info.version, updates, this.ctx.now()).text);
    else setText(this.verStatus, '');

    const checkable = !!updates && updates.state !== 'off';
    setHidden(this.checkBtn, !checkable);
    this.checkBtn.disabled = this.checking;

    // Botão "Atualizar": habilitado quando há atualização OU quando a verificação está desligada (atualizar = rodar o
    // instalador); desabilitado só quando sabemos que já está na mais recente.
    const canUpdate = !!this.ctx.startUpdate && (fresh || !checkable);
    this.updateBtn.disabled = !canUpdate || upToDate;
    setText(this.updateBtn, fresh && latest ? tr('Atualizar para v{0}', [latest]) : tr('Atualizar Córtex'));
    setHidden(this.updateNote, !upToDate);
    if (upToDate) setText(this.updateNote, tr('Você já está na versão mais recente.'));
  }

  /** "Verificar agora": POST /api/updates/check. O resultado chega pelo snapshot (SSE) e o render se atualiza. */
  private async checkNow(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    this.render();
    try {
      await fetch('/api/updates/check', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } catch {
      // erro de rede: o texto de estado volta ao normal no próximo render
    } finally {
      this.checking = false;
      this.ctx.invalidate();
    }
  }

  /** Rola até a seção e a destaca por um instante (clique no número da versão). */
  highlight(): void {
    this.el.scrollIntoView({ block: 'nearest' });
    this.el.classList.remove('is-highlight');
    void this.el.offsetWidth;
    this.el.classList.add('is-highlight');
  }
}
