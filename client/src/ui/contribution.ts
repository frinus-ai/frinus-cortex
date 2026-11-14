// Painel "Contribuição" da gaveta do agente (Frinus Córtex): o que o agente somou à memória de longo prazo e ao
// trabalho da sessão, em linguagem de cliente leigo. Sem ranking entre agentes e sem moedas — só os números do
// próprio agente, montados de dados que o cliente já tem (AgentInfo.stats, tasks e as entregas via ctx.deliveries).
import type { AgentInfo } from '../../../shared/types';
import type { UiContext } from './context';
import { h, setHidden, setText } from './dom';
import { formatInt } from './format';
import { tr } from '../../../shared/i18n';

type TileKey = 'memories' | 'searches' | 'specialists' | 'tasks' | 'deliveries';

interface Tile {
  el: HTMLElement;
  value: HTMLElement;
}

/** Um mosaico de contador: ícone, número grande e rótulo. */
function tile(icon: string, label: string, hint: string): Tile {
  const value = h('strong', { class: 'ui-contrib__value' });
  const el = h(
    'div',
    { class: 'ui-contrib__tile', title: hint },
    h('span', { class: 'ui-contrib__icon', attrs: { 'aria-hidden': 'true' }, text: icon }),
    h('div', { class: 'ui-contrib__body' }, value, h('span', { class: 'ui-contrib__label', text: label })),
  );
  return { el, value };
}

export class ContributionSection {
  readonly el: HTMLElement;
  private tiles: Record<TileKey, Tile>;

  constructor(private ctx: UiContext) {
    const title = h('h3', { class: 'ui-sec__title', text: tr('Contribuição') });
    this.tiles = {
      memories: tile('🧠', tr('Memórias gravadas'), tr('Fatos e aprendizados que o agente guardou na memória de longo prazo do Frinus.')),
      searches: tile('🔎', tr('Consultas à memória'), tr('Vezes que o agente buscou na memória do Frinus antes de agir.')),
      specialists: tile('👥', tr('Especialistas acionados'), tr('Especialistas do time que o agente acionou para ajudar nesta sessão.')),
      tasks: tile('✅', tr('Tarefas concluídas'), tr('Tarefas da lista do agente já finalizadas nesta sessão.')),
      deliveries: tile('📦', tr('Entregas'), tr('Pedidos que o agente terminou e entregou.')),
    };
    this.el = h(
      'section',
      { class: 'ui-sec ui-contrib' },
      h('div', { class: 'ui-sec__head' }, title),
      h('div', { class: 'ui-contrib__grid' }, this.tiles.memories.el, this.tiles.searches.el, this.tiles.specialists.el, this.tiles.tasks.el, this.tiles.deliveries.el),
    );
  }

  render(a: AgentInfo): void {
    const s = a.stats;
    setText(this.tiles.memories.value, formatInt(s.memoriesStored ?? 0));
    setText(this.tiles.searches.value, formatInt(s.memorySearches ?? 0));
    // Delegação a especialistas só faz sentido para a sessão principal (o orquestrador); o especialista não delega.
    setHidden(this.tiles.specialists.el, a.kind !== 'main');
    setText(this.tiles.specialists.value, formatInt(s.subagents));
    setText(this.tiles.tasks.value, formatInt(a.tasks.filter((t) => t.status === 'completed').length));
    const mine = (this.ctx.deliveries?.() ?? []).filter((d) => (d.agentId ? d.agentId === a.id : d.sessionId === a.sessionId));
    setText(this.tiles.deliveries.value, formatInt(mine.length));
  }
}
