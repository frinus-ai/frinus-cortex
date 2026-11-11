import { describe, expect, it } from 'vitest';
import { clusterCenter, hippocampus, orbit } from './layout';
import { TILE } from '../constants';

describe('layout da cena Cérebro', () => {
  it('orbit: um único corpo fica no centro (levemente acima)', () => {
    const p = orbit(100, 100, 0, 1, 40, 0);
    expect(p.x).toBe(100);
    expect(p.y).toBeLessThan(100);
  });

  it('orbit: distribui n corpos em volta do centro (elipse achatada em y)', () => {
    const n = 4;
    const pts = Array.from({ length: n }, (_, i) => orbit(0, 0, i, n, 50, 0));
    // o primeiro sai na horizontal (fase 0); raio x = 50, raio y = 50*0.62
    expect(pts[0].x).toBeCloseTo(50, 5);
    expect(pts[0].y).toBeCloseTo(0, 5);
    // corpos diferentes ocupam ângulos diferentes
    const uniq = new Set(pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`));
    expect(uniq.size).toBe(n);
    // nenhum ponto passa do raio horizontal
    for (const p of pts) expect(Math.abs(p.x)).toBeLessThanOrEqual(50 + 1e-6);
  });

  it('clusterCenter: centro do retângulo da sala em px de mundo', () => {
    expect(clusterCenter({ x: 2, y: 0, w: 12, h: 12 })).toEqual({ x: 8 * TILE, y: 6 * TILE });
  });

  it('hippocampus: centro horizontal do prédio, na faixa do corredor', () => {
    const h = hippocampus({ building: { cols: 6 } } as never);
    expect(h.x).toBe((6 * 16 * TILE) / 2);
    // faixa do corredor (centro vertical do prédio)
    expect(h.y).toBe(14.5 * TILE);
  });
});
