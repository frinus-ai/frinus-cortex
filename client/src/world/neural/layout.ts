// Layout "cérebro" (cena Frinus): posições dos núcleos (projetos), somas (sessões),
// neurônios (subagentes) e do hipocampo. Reaproveita a geometria do prédio como
// esqueleto da constelação — o centro de cada sala vira o núcleo de um cluster, e a
// faixa do corredor (centro vertical) abriga o hipocampo. Assim o picking de sala
// (world/index.ts usa room.layout.rect) continua coincidindo com o que é desenhado.
import { COL_W, CORRIDOR_Y, SOUTH_Y, TILE } from '../constants';
import type { Sim } from '../sim/sim';

/** Posição orbital do i-ésimo de n corpos ao redor de (cx, cy). Elipse achatada em y. */
export function orbit(cx: number, cy: number, i: number, n: number, radius: number, phase: number): { x: number; y: number } {
  if (n <= 1) return { x: cx, y: cy - radius * 0.25 };
  const a = phase + (i / n) * Math.PI * 2;
  return { x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius * 0.62 };
}

/** Hipocampo: núcleo de memória no centro do córtex (faixa do corredor). */
export function hippocampus(sim: Sim): { x: number; y: number } {
  const w = Math.max(1, sim.building.cols) * COL_W * TILE;
  return { x: w / 2, y: ((CORRIDOR_Y + SOUTH_Y) / 2) * TILE };
}

/** Centro do cluster de um projeto: centro do retângulo da sala (coords de mundo). */
export function clusterCenter(rect: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  return { x: (rect.x + rect.w / 2) * TILE, y: (rect.y + rect.h / 2) * TILE };
}
