// Cena "Cérebro" (tema Frinus): um córtex escuro onde cada sessão do Claude Code é um
// soma pulsante, cada subagente é um neurônio ligado por uma sinapse, e a memória
// gravada/consultada sobe/desce como pulso âmbar até o hipocampo central.
//
// Desenha em coordenadas de mundo (mesma transform da câmera do escritório), então o
// pan/zoom, o enquadramento (overview) e o picking (world/index.ts usa renderer.heads
// e room.layout.rect) continuam valendo sem tocar na rede, no server nem na UI.
import type { Camera } from '../camera';
import type { HeadInfo } from '../render/renderer';
import type { Sim } from '../sim/sim';
import type { Character } from '../sim/character';
import type { WorldOptions } from '../api';
import { COL_W, TILE } from '../constants';
import { clusterCenter, hippocampus, orbit } from './layout';

/** Paleta do conceito (docs/planos/CONCEITO-frinus-cerebro.md). */
const INK = '#1A1A2E';
const CORTEX = '#12121f';
const PURPLE = '#6C3FC4';
const PURPLE_DK = '#5A32A8';
const LAVENDER = '#EFE9FB';
const MIST = '#F7F4FD';
const AMBER = '#E8B860';
const GREEN = '#8de0b0';

interface MemPulse {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  start: number;
  dur: number;
  /** true = sobe ao hipocampo (gravar); false = desce do hipocampo (consultar). */
  up: boolean;
}

interface BgNet {
  cols: number;
  pts: { x: number; y: number }[];
  links: [number, number][];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Converte #rrggbb + alpha em rgba(). */
function rgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Estado visual de um soma/neurônio derivado do status do agente. */
function phaseOf(ch: Character): 'work' | 'wait' | 'done' | 'idle' | 'offline' {
  const s = ch.info.status;
  if (s === 'waiting') return 'wait';
  if (s === 'offline') return 'offline';
  if (s === 'done' || ch.mode === 'deliver') return 'done';
  if (s === 'working' || s === 'shell' || ch.mode === 'work') return 'work';
  return 'idle';
}

/** Detecta operação de memória do Frinus na atividade atual (para o pulso âmbar). */
function memOp(ch: Character): 'store' | 'recall' | null {
  const a = ch.info.activity;
  if (!a) return null;
  const tool = a.tool ?? '';
  const txt = a.text ?? '';
  if (/memory_store/i.test(tool) || /Guardando na memória/i.test(txt) || a.icon === '🧠') return 'store';
  if (/memory_search|search_with_attention|memory_get_context/i.test(tool) || /Consultando a memória/i.test(txt)) return 'recall';
  return null;
}

export class NeuralScene {
  private pulses: MemPulse[] = [];
  private memSeen = new Map<string, string>();
  private bg: BgNet | null = null;
  /** Centros de cluster do último layout (por sala), para o desenho. */
  private clusters = new Map<string, { x: number; y: number; r: number; color: string }>();
  private hip = { x: 0, y: 0 };
  /** Retângulo de mundo (px) que envolve a constelação — a câmera enquadra por ele (world/index.ts). */
  private bounds: { x: number; y: number; w: number; h: number } | null = null;

  /** Limites da constelação para o enquadramento da câmera (null até o 1º layout). */
  getBounds(): { x: number; y: number; w: number; h: number } | null {
    return this.bounds;
  }

  /** Centróide dos clusters (ou centro do prédio se não houver sala). */
  private centroid(sim: Sim): { x: number; y: number } {
    if (!this.clusters.size) return hippocampus(sim);
    let sx = 0;
    let sy = 0;
    for (const c of this.clusters.values()) {
      sx += c.x;
      sy += c.y;
    }
    return { x: sx / this.clusters.size, y: hippocampus(sim).y };
  }

  /** Caixa envolvente dos clusters + hipocampo, com folga. */
  private computeBounds(): { x: number; y: number; w: number; h: number } | null {
    if (!this.clusters.size) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const acc = (x: number, y: number, r: number) => {
      x0 = Math.min(x0, x - r);
      y0 = Math.min(y0, y - r);
      x1 = Math.max(x1, x + r);
      y1 = Math.max(y1, y + r);
    };
    for (const c of this.clusters.values()) acc(c.x, c.y, c.r + 30);
    acc(this.hip.x, this.hip.y, 70);
    const pad = 60;
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  }

  // ---------------------------------------------------------------- layout (coords de mundo)

  /**
   * Posiciona somas e neurônios (escreve ch.x/ch.y) para que a câmera, o picking e os
   * balões/etiquetas do overlay leiam as posições da constelação. Chamado a cada frame,
   * depois de sim.update e antes da câmera.
   */
  layout(sim: Sim, now: number): void {
    this.clusters.clear();
    const spin = now / 9000;

    for (const room of sim.rooms.values()) {
      if (!room.present) continue;
      const c = clusterCenter(room.layout.rect);
      // somas (sessões principais) desta sala
      const mains = [...sim.chars.values()].filter((ch) => ch.roomId === room.id && ch.info.kind === 'main' && !ch.gone);
      const spread = Math.max(26, Math.min(42, (room.layout.rect.w * TILE) / 3));
      mains.forEach((ch, i) => {
        const p = orbit(c.x, c.y, i, mains.length, spread, spin * 0.6);
        this.place(ch, p.x, p.y);
      });
      const color = this.accountColor(sim, mains[0]) ?? PURPLE;
      this.clusters.set(room.id, { x: c.x, y: c.y, r: spread + 34, color });
    }

    // hipocampo no centróide dos clusters (centra a composição) e limites do enquadramento
    this.hip = this.centroid(sim);
    this.bounds = this.computeBounds();

    // neurônios (subagentes) orbitam o pai
    for (const ch of sim.chars.values()) {
      if (ch.info.kind !== 'sub' || ch.gone) continue;
      const parent = ch.info.parentId ? sim.chars.get(ch.info.parentId) : undefined;
      const sibs = [...sim.chars.values()].filter((s) => s.info.kind === 'sub' && s.info.parentId === ch.info.parentId && !s.gone);
      const i = Math.max(0, sibs.indexOf(ch));
      if (parent) {
        const p = orbit(parent.x, parent.y, i, Math.max(2, sibs.length), 34, spin * 1.4 + 0.6);
        this.place(ch, p.x, p.y);
      } else {
        // sub órfão: orbita o hipocampo
        const p = orbit(this.hip.x, this.hip.y, i, Math.max(2, sibs.length), 90, spin);
        this.place(ch, p.x, p.y);
      }
    }
  }

  private place(ch: Character, x: number, y: number): void {
    ch.x = x;
    ch.y = y;
    ch.visible = !ch.gone;
    ch.inside = false;
    ch.hiddenUntil = 0;
  }

  private accountColor(sim: Sim, ch: Character | undefined): string | undefined {
    if (!ch) return undefined;
    return sim.accounts.get(ch.info.account)?.color;
  }

  // ---------------------------------------------------------------- desenho

  draw(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    canvas: HTMLCanvasElement,
    sim: Sim,
    now: number,
    _dt: number,
    opts: WorldOptions,
    sel: { agent: string | null; room: string | null; hover: string | null },
    heads: Map<string, HeadInfo>,
  ): void {
    const dark = opts.daylight !== 'day';
    const W = canvas.width;
    const H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    // fundo cortical
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    if (dark) {
      bg.addColorStop(0, '#15152a');
      bg.addColorStop(1, CORTEX);
    } else {
      bg.addColorStop(0, MIST);
      bg.addColorStop(1, LAVENDER);
    }
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const { scale, ox, oy } = camera.transform();
    ctx.setTransform(scale, 0, 0, scale, ox, oy);

    this.drawBrainGlow(ctx, sim, dark);
    this.drawCortexNet(ctx, sim, now, dark);
    this.spawnMemPulses(sim, now);
    this.drawSynapses(ctx, sim, now);
    this.drawMemPulses(ctx, now);
    this.drawHippocampus(ctx, now, dark);
    this.drawClusters(ctx, sim, dark);

    // somas e neurônios (por profundidade) + heads para o picking/overlay
    const drawn = new Set<string>();
    const people = [...sim.chars.values()].filter((ch) => ch.visible && !ch.gone).sort((a, b) => a.y - b.y);
    for (const ch of people) {
      this.drawCell(ctx, sim, ch, now, sel, dark);
      this.markHead(ch, heads);
      drawn.add(ch.id);
    }
    for (const [id, h] of heads) if (!drawn.has(id)) h.visible = false;
  }

  /** Silhueta de cérebro como moldura de glow atrás da constelação. */
  private drawBrainGlow(ctx: CanvasRenderingContext2D, _sim: Sim, dark: boolean): void {
    const b = this.bounds;
    const cx = b ? b.x + b.w / 2 : this.hip.x;
    const cy = b ? b.y + b.h / 2 : this.hip.y;
    const hw = Math.max(360, (b ? b.w : 760) * 0.6);
    const hh = Math.max(230, hw * 0.66);
    ctx.save();
    const g = ctx.createRadialGradient(cx, cy, hw * 0.1, cx, cy, hw * 1.05);
    g.addColorStop(0, rgba(PURPLE, dark ? 0.16 : 0.1));
    g.addColorStop(0.6, rgba(PURPLE_DK, dark ? 0.07 : 0.05));
    g.addColorStop(1, rgba(PURPLE_DK, 0));
    ctx.fillStyle = g;
    this.brainPath(ctx, cx, cy, hw, hh);
    ctx.fill();
    // contorno tênue + fissura central
    ctx.strokeStyle = rgba(dark ? LAVENDER : PURPLE_DK, dark ? 0.14 : 0.18);
    ctx.lineWidth = 2;
    this.brainPath(ctx, cx, cy, hw, hh);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy - hh * 0.86);
    ctx.bezierCurveTo(cx - hw * 0.08, cy - hh * 0.3, cx + hw * 0.08, cy + hh * 0.3, cx, cy + hh * 0.72);
    ctx.stroke();
    ctx.restore();
  }

  private brainPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, hw: number, hh: number): void {
    const lobes = 9;
    const steps = 80;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      // giros: ondulação; base levemente achatada
      const bump = 1 + 0.05 * Math.cos(lobes * t) + 0.03 * Math.cos(2 * t);
      const flat = t > Math.PI ? 0.86 : 1; // fundo mais chato
      const x = cx + Math.cos(t) * hw * bump;
      const y = cy + Math.sin(t) * hh * bump * flat;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  /** Tecido cortical: rede tênue de fundo, determinística. */
  private drawCortexNet(ctx: CanvasRenderingContext2D, sim: Sim, now: number, dark: boolean): void {
    const cols = Math.max(1, sim.building.cols);
    if (!this.bg || this.bg.cols !== cols) this.bg = this.buildBgNet(sim, cols);
    const b = this.bg;
    const pulse = 0.5 + 0.5 * Math.sin(now / 2600);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(dark ? PURPLE : PURPLE_DK, dark ? 0.08 : 0.07);
    ctx.beginPath();
    for (const [a, c] of b.links) {
      ctx.moveTo(b.pts[a].x, b.pts[a].y);
      ctx.lineTo(b.pts[c].x, b.pts[c].y);
    }
    ctx.stroke();
    ctx.fillStyle = rgba(dark ? LAVENDER : PURPLE_DK, (dark ? 0.1 : 0.12) * (0.6 + pulse * 0.4));
    for (const p of b.pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private buildBgNet(sim: Sim, cols: number): BgNet {
    const w = cols * COL_W * TILE;
    const h = 29 * TILE;
    const rng = mulberry(cols * 0x9e3779b1 + 7);
    const pts: { x: number; y: number }[] = [];
    const nx = Math.max(6, Math.round(w / 90));
    const ny = 7;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        pts.push({ x: (i + 0.5 + (rng() - 0.5) * 0.7) * (w / nx) - w * 0.04, y: (j + 0.5 + (rng() - 0.5) * 0.7) * (h / ny) - h * 0.2 });
      }
    const links: [number, number][] = [];
    for (let a = 0; a < pts.length; a++)
      for (let c = a + 1; c < pts.length; c++) {
        const dx = pts[a].x - pts[c].x;
        const dy = pts[a].y - pts[c].y;
        if (dx * dx + dy * dy < 130 * 130 && rng() < 0.5) links.push([a, c]);
      }
    return { cols, pts, links };
  }

  // ---------------------------------------------------------------- hipocampo e memória

  private drawHippocampus(ctx: CanvasRenderingContext2D, now: number, dark: boolean): void {
    const { x, y } = this.hip;
    const pulse = 0.5 + 0.5 * Math.sin(now / 900);
    const R = 22 + pulse * 3;
    ctx.save();
    const g = ctx.createRadialGradient(x, y, 2, x, y, R * 3);
    g.addColorStop(0, rgba(AMBER, 0.95));
    g.addColorStop(0.3, rgba(AMBER, 0.4));
    g.addColorStop(1, rgba(AMBER, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, R * 3, 0, Math.PI * 2);
    ctx.fill();
    // anéis
    ctx.strokeStyle = rgba(AMBER, 0.7);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = rgba(AMBER, 0.3 + pulse * 0.3);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, R + 7 + pulse * 4, 0, Math.PI * 2);
    ctx.stroke();
    // núcleo
    ctx.fillStyle = rgba('#fff4dd', 0.9);
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    // rótulo
    ctx.fillStyle = rgba(dark ? AMBER : '#9a7320', 0.9);
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('hipocampo', x, y + R + 18);
    ctx.restore();
  }

  private spawnMemPulses(sim: Sim, now: number): void {
    for (const ch of sim.chars.values()) {
      if (ch.gone) continue;
      const op = memOp(ch);
      const key = ch.info.activity?.id ?? '';
      if (!op || !key) continue;
      if (this.memSeen.get(ch.id) === key) continue;
      this.memSeen.set(ch.id, key);
      const up = op === 'store';
      this.pulses.push({ x0: ch.x, y0: ch.y, x1: this.hip.x, y1: this.hip.y, start: now, dur: 1500, up });
    }
    // limpa memória de atividades de quem saiu
    if (this.memSeen.size > 200) this.memSeen.clear();
  }

  private drawMemPulses(ctx: CanvasRenderingContext2D, now: number): void {
    ctx.save();
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      const t = (now - p.start) / p.dur;
      if (t >= 1) {
        this.pulses.splice(i, 1);
        continue;
      }
      const from = p.up ? 0 : 1;
      const to = p.up ? 1 : 0;
      const k = from + (to - from) * t;
      const x = lerp(p.x0, p.x1, k);
      const y = lerp(p.y0, p.y1, k);
      // trilha
      ctx.strokeStyle = rgba(AMBER, 0.2 * (1 - t));
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x0, p.y0);
      ctx.lineTo(p.x1, p.y1);
      ctx.stroke();
      const g = ctx.createRadialGradient(x, y, 0, x, y, 10);
      g.addColorStop(0, rgba('#fff0cf', 0.95));
      g.addColorStop(0.4, rgba(AMBER, 0.8));
      g.addColorStop(1, rgba(AMBER, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- clusters e sinapses

  private drawClusters(ctx: CanvasRenderingContext2D, sim: Sim, dark: boolean): void {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [id, cl] of this.clusters) {
      const room = sim.rooms.get(id);
      if (!room) continue;
      const g = ctx.createRadialGradient(cl.x, cl.y, cl.r * 0.2, cl.x, cl.y, cl.r);
      g.addColorStop(0, rgba(cl.color, dark ? 0.14 : 0.1));
      g.addColorStop(1, rgba(cl.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cl.x, cl.y, cl.r, 0, Math.PI * 2);
      ctx.fill();
      // rótulo do projeto
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillStyle = rgba(dark ? LAVENDER : INK, 0.85);
      ctx.fillText(room.info.name, cl.x, cl.y - cl.r - 8);
    }
    ctx.restore();
  }

  private drawSynapses(ctx: CanvasRenderingContext2D, sim: Sim, now: number): void {
    ctx.save();
    for (const ch of sim.chars.values()) {
      if (ch.info.kind !== 'sub' || ch.gone) continue;
      const parent = ch.info.parentId ? sim.chars.get(ch.info.parentId) : undefined;
      if (!parent || parent.gone) continue;
      const color = sim.accounts.get(ch.info.account)?.color ?? PURPLE;
      const mx = (parent.x + ch.x) / 2 + (ch.y - parent.y) * 0.18;
      const my = (parent.y + ch.y) / 2 - (ch.x - parent.x) * 0.18;
      // axônio
      ctx.strokeStyle = rgba(color, 0.4);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(parent.x, parent.y);
      ctx.quadraticCurveTo(mx, my, ch.x, ch.y);
      ctx.stroke();
      // pulso viajando pai -> neurônio
      const t = ((now / 1100) % 1 + ch.x * 0.0003) % 1;
      const px = (1 - t) * (1 - t) * parent.x + 2 * (1 - t) * t * mx + t * t * ch.x;
      const py = (1 - t) * (1 - t) * parent.y + 2 * (1 - t) * t * my + t * t * ch.y;
      const g = ctx.createRadialGradient(px, py, 0, px, py, 6);
      g.addColorStop(0, rgba('#ffffff', 0.9));
      g.addColorStop(0.5, rgba(color, 0.8));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- soma / neurônio

  private drawCell(
    ctx: CanvasRenderingContext2D,
    sim: Sim,
    ch: Character,
    now: number,
    sel: { agent: string | null; hover: string | null },
    dark: boolean,
  ): void {
    const sub = ch.info.kind === 'sub';
    const color = sim.accounts.get(ch.info.account)?.color ?? PURPLE;
    const ph = phaseOf(ch);
    const selected = sel.agent === ch.id;
    const hovered = sel.hover === ch.id;
    const baseR = sub ? 9 : 14;

    // respiração por estado
    let speed = 1700;
    let amp = 0.1;
    let bright = 0.8;
    if (ph === 'work') {
      speed = 620;
      amp = 0.16;
      bright = 1;
    } else if (ph === 'idle') {
      speed = 2600;
      amp = 0.07;
      bright = 0.55;
    } else if (ph === 'offline') {
      bright = 0.3;
      amp = 0.03;
    }
    const pulse = 0.5 + 0.5 * Math.sin(now / speed + ch.x);
    const R = baseR * (1 + amp * pulse);
    const x = ch.x;
    const y = ch.y;

    ctx.save();
    // dendritos
    this.drawDendrites(ctx, ch, color, R, now, ph);

    // glow externo
    const glow = ctx.createRadialGradient(x, y, R * 0.3, x, y, R * (ph === 'work' ? 3.1 : 2.3));
    glow.addColorStop(0, rgba(color, 0.5 * bright));
    glow.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, R * 3.1, 0, Math.PI * 2);
    ctx.fill();

    // corpo
    const body = ctx.createRadialGradient(x - R * 0.3, y - R * 0.3, 1, x, y, R);
    body.addColorStop(0, rgba('#ffffff', 0.55 * bright + 0.15));
    body.addColorStop(0.35, color);
    body.addColorStop(1, dark ? PURPLE_DK : color);
    ctx.fillStyle = body;
    ctx.globalAlpha = ph === 'offline' ? 0.55 : 1;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // faíscas quando trabalhando
    if (ph === 'work') {
      const n = sub ? 2 : 3;
      for (let i = 0; i < n; i++) {
        const a = now / 300 + (i / n) * Math.PI * 2 + ch.x;
        const rr = R * (1.5 + 0.3 * Math.sin(now / 200 + i));
        ctx.fillStyle = rgba('#fff6e0', 0.8);
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * rr, y + Math.sin(a) * rr, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // letra da conta
    if (!sub || R > 8) {
      const short = sim.accounts.get(ch.info.account)?.short ?? '•';
      ctx.fillStyle = luminance(color) > 0.6 ? '#1d1630' : '#ffffff';
      ctx.font = `700 ${Math.round(R * (sub ? 0.9 : 1.05))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(short.slice(0, 2), x, y + 0.5);
    }

    // conclusão: flash verde-lavanda
    if (ph === 'done') {
      const fp = 0.5 + 0.5 * Math.sin(now / 420);
      ctx.strokeStyle = rgba(GREEN, 0.5 + fp * 0.4);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, R + 5 + fp * 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    // precisa de você: anel âmbar piscando + chave
    if (ph === 'wait') {
      const blink = 0.4 + 0.6 * Math.abs(Math.sin(now / 420));
      ctx.strokeStyle = rgba(AMBER, blink);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, R + 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = rgba(AMBER, blink);
      ctx.font = '700 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🔑', x + R + 10, y - R - 6);
    }

    // seleção / hover
    if (selected || hovered) {
      ctx.strokeStyle = rgba(selected ? MIST : LAVENDER, selected ? 0.95 : 0.6);
      ctx.lineWidth = selected ? 3 : 2;
      ctx.beginPath();
      ctx.arc(x, y, R + (selected ? 4 : 2.5), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawDendrites(ctx: CanvasRenderingContext2D, ch: Character, color: string, R: number, now: number, ph: 'work' | 'wait' | 'done' | 'idle' | 'offline'): void {
    const n = ch.info.kind === 'sub' ? 4 : 6;
    const vibrate = ph === 'work' ? Math.sin(now / 90 + ch.x) * 0.18 : 0;
    ctx.strokeStyle = rgba(color, ph === 'offline' ? 0.15 : 0.35);
    ctx.lineWidth = 1.4;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + ch.y * 0.01 + vibrate;
      const len = R * (1.9 + (i % 2) * 0.6);
      const ex = ch.x + Math.cos(a) * len;
      const ey = ch.y + Math.sin(a) * len;
      const mx = ch.x + Math.cos(a + 0.3) * len * 0.55;
      const my = ch.y + Math.sin(a + 0.3) * len * 0.55;
      ctx.beginPath();
      ctx.moveTo(ch.x + Math.cos(a) * R, ch.y + Math.sin(a) * R);
      ctx.quadraticCurveTo(mx, my, ex, ey);
      ctx.stroke();
    }
  }

  private markHead(ch: Character, heads: Map<string, HeadInfo>): void {
    let h = heads.get(ch.id);
    if (!h) heads.set(ch.id, (h = { x: 0, y: 0, feetY: 0, visible: false, bx: 0, by: 0, bw: 0, bh: 0, depth: 0 }));
    const R = (ch.info.kind === 'sub' ? 9 : 14) + 4;
    h.x = ch.x;
    h.y = ch.y - R; // topo do corpo (âncora da etiqueta/janela)
    h.feetY = ch.y + R;
    h.visible = true;
    h.bx = ch.x - R;
    h.by = ch.y - R;
    h.bw = R * 2;
    h.bh = R * 2;
    h.depth = ch.y;
  }
}
