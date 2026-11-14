// Avatares dos agentes para a UI. No Frinus Córtex não há rosto: orbe com a logo (sessão) ou neurônio (especialista).
import type { AgentInfo } from '../../../shared/types';
import { h } from './dom';

type AvatarSource = Pick<AgentInfo, 'seed' | 'look' | 'kind' | 'parts'>;

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';

/** Moldura do avatar (caixa com fundo) + imagem em tamanho natural, alinhada pelos ombros. */
export function createAvatar(agent: AvatarSource, size: AvatarSize): HTMLElement {
  const box = createAvatarPlaceholder(size);
  updateAvatar(box, agent, size);
  return box;
}

/** Moldura vazia (agente desconhecido); `updateAvatar` preenche depois. */
export function createAvatarPlaceholder(size: AvatarSize): HTMLElement {
  return h('span', { class: `ui-avatar ui-avatar--${size}`, attrs: { 'aria-hidden': 'true' } });
}

/**
 * Frinus Córtex: o agente não tem rosto. A sessão principal (o orquestrador Frinus) é um orbe com a logo;
 * o subagente (especialista do time) é um neurônio — núcleo com dendritos. Cor vem de --acc (conta).
 */
// Neurônio: núcleo + dendritos curvos (recebem) de um lado e um axônio de luz (projeta) do outro —
// a mesma leitura da cena Cérebro, só que no tamanho do avatar.
const NEURON_SVG =
  '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-linecap="round">' +
  '<g stroke-width="1.5" opacity=".7">' +
  '<path d="M13 13 Q6 9 4 4 M13 13 Q7 12 3 13 M13 14 Q8 18 5 24 M16 12 Q15 6 17 2"/>' +
  '</g>' +
  '<circle cx="4" cy="4" r="1.5" fill="currentColor" stroke="none"/><circle cx="3" cy="13" r="1.4" fill="currentColor" stroke="none"/>' +
  '<circle cx="5" cy="24" r="1.4" fill="currentColor" stroke="none"/><circle cx="17" cy="2" r="1.3" fill="currentColor" stroke="none"/>' +
  '<path d="M19 17 Q25 22 28 28" stroke-width="1.8" opacity=".95"/>' +
  '<circle cx="28" cy="28" r="1.8" fill="currentColor" stroke="none"/>' +
  '<circle cx="15" cy="15" r="5.4" fill="currentColor" stroke="none"/>' +
  '<circle cx="15" cy="15" r="2" fill="#14121f" stroke="none" opacity=".55"/></svg>';

/** Atualiza o avatar só se o tipo (sessão principal × subagente) mudou. */
export function updateAvatar(box: HTMLElement, agent: AvatarSource, _size: AvatarSize): void {
  const sig = agent.kind;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.classList.add('ui-avatar--frinus');
  box.classList.toggle('ui-avatar--sub', agent.kind === 'sub');
  if (agent.kind === 'sub') {
    box.innerHTML = NEURON_SVG;
    return;
  }
  box.innerHTML = '';
  box.append(h('img', { attrs: { src: '/assets/brand/frinus-logo-white.svg', alt: '', draggable: 'false', decoding: 'async' } }));
}
