// Cena "Cérebro" (tema Frinus): uma silhueta inconfundível de cérebro — dois hemisférios
// com giros e sulcos — ocupando a tela, com o hipocampo (núcleo de memória) no centro.
// Cada projeto/pasta é uma REGIÃO delimitada (lobo com borda, tom e rótulo próprios)
// distribuída pelo cérebro inteiro. Cada sessão do Claude Code é um soma desenhado com a
// LOGO do Frinus + a letra da conta (sem nome de pessoa — detalhes no hover). Cada subagente
// é um neurônio ligado por sinapse. Memória gravada/consultada pulsa em âmbar até o hipocampo.
//
// Desenha em coordenadas de mundo (transform da câmera do escritório): pan/zoom, enquadramento
// e picking (world/index.ts usa renderer.heads) continuam valendo sem tocar no server/rede/UI.
import type { Camera } from '../camera';
import type { HeadInfo } from '../render/renderer';
import type { Sim } from '../sim/sim';
import type { Character } from '../sim/character';
import type { WorldOptions } from '../api';
import { orbit } from './layout';
import { FRINUS_LOGO_DATA_URL } from './logo';

/** Paleta do conceito (docs/planos/CONCEITO-frinus-cerebro.md). */
const CORTEX = '#12121f';
const PURPLE = '#6C3FC4';
const PURPLE_DK = '#5A32A8';
const LAVENDER = '#EFE9FB';
const MIST = '#F7F4FD';
const INK = '#1A1A2E';
const AMBER = '#E8B860';
const GREEN = '#8de0b0';

interface MemPulse {
  x0: number;
  y0: number;
  start: number;
  dur: number;
  up: boolean;
}

interface Region {
  x: number;
  y: number;
  r: number;
  color: string;
  name: string;
  seed: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  return (0.299 * parseInt(h.slice(0, 2), 16) + 0.587 * parseInt(h.slice(2, 4), 16) + 0.114 * parseInt(h.slice(4, 6), 16)) / 255;
}

function rgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}

function phaseOf(ch: Character): 'work' | 'wait' | 'done' | 'idle' | 'offline' {
  const s = ch.info.status;
  if (s === 'waiting') return 'wait';
  if (s === 'offline') return 'offline';
  if (s === 'done' || ch.mode === 'deliver') return 'done';
  if (s === 'working' || s === 'shell' || ch.mode === 'work') return 'work';
  return 'idle';
}

/** Operação de memória do Frinus na atividade atual (pulso âmbar sobe=gravar, desce=consultar). */
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
  private regions = new Map<string, Region>();
  private center = { x: 0, y: 0 };
  private hw = 760;
  private hh = 600;
  private bounds: { x: number; y: number; w: number; h: number } | null = null;
  private logo: HTMLImageElement | null = null;
  private logoReady = false;

  constructor() {
    if (typeof Image !== 'undefined') {
      const img = new Image();
      img.onload = () => (this.logoReady = true);
      img.src = FRINUS_LOGO_DATA_URL;
      this.logo = img;
    }
  }

  getBounds(): { x: number; y: number; w: number; h: number } | null {
    return this.bounds;
  }

  // ---------------------------------------------------------------- layout

  layout(sim: Sim, now: number): void {
    this.regions.clear();
    const spin = now / 11000;
    const rooms = [...sim.rooms.values()].filter((r) => r.present).sort((a, b) => a.slot - b.slot);
    const n = Math.max(1, rooms.length);

    // Cérebro paisagem (dois hemisférios lado a lado). Tamanho cresce um pouco com o nº de projetos.
    this.hw = 700 + Math.min(260, n * 42);
    this.hh = this.hw * 0.74;
    this.center = { x: 0, y: 0 };

    // Âncoras das regiões: elipse interna, distribuídas por ângulo (equilíbrio esquerda/direita, topo/base).
    const ringRx = this.hw * 0.5;
    const ringRy = this.hh * 0.52;
    const regionR = Math.max(72, Math.min(240, Math.min(this.hw, this.hh) * (n <= 2 ? 0.4 : n <= 4 ? 0.33 : n <= 6 ? 0.27 : 0.22)));

    rooms.forEach((room, i) => {
      // começa no alto; para n par, desloca meio passo para não ficar em cima da fissura.
      const ang = -Math.PI / 2 + (i / n) * Math.PI * 2 + (n % 2 === 0 ? Math.PI / n : 0);
      const ax = n === 1 ? this.center.x : this.center.x + Math.cos(ang) * ringRx;
      const ay = n === 1 ? this.center.y - this.hh * 0.42 : this.center.y + Math.sin(ang) * ringRy;
      const mains = [...sim.chars.values()].filter((ch) => ch.roomId === room.id && ch.info.kind === 'main' && !ch.gone);
      const color = this.accountColor(sim, mains[0]) ?? PURPLE;
      this.regions.set(room.id, { x: ax, y: ay, r: regionR, color, name: room.info.name, seed: (room.seed ?? room.slot ?? i) >>> 0 });
      const somaOrbit = Math.min(regionR * 0.46, 54);
      mains.forEach((ch, j) => {
        const p = orbit(ax, ay, j, mains.length, somaOrbit, spin * 0.5);
        this.place(ch, p.x, p.y);
      });
    });

    // neurônios (subagentes) orbitam o pai
    for (const ch of sim.chars.values()) {
      if (ch.info.kind !== 'sub' || ch.gone) continue;
      const parent = ch.info.parentId ? sim.chars.get(ch.info.parentId) : undefined;
      const sibs = [...sim.chars.values()].filter((s) => s.info.kind === 'sub' && s.info.parentId === ch.info.parentId && !s.gone);
      const i = Math.max(0, sibs.indexOf(ch));
      const base = parent ?? { x: this.center.x, y: this.center.y };
      const p = orbit(base.x, base.y, i, Math.max(2, sibs.length), parent ? 40 : 110, spin * 1.5 + 0.6);
      this.place(ch, p.x, p.y);
    }

    const pad = 70;
    this.bounds = { x: this.center.x - this.hw - pad, y: this.center.y - this.hh - pad, w: 2 * (this.hw + pad), h: 2 * (this.hh + pad) };
  }

  private place(ch: Character, x: number, y: number): void {
    ch.x = x;
    ch.y = y;
    ch.visible = !ch.gone;
    ch.inside = false;
    ch.hiddenUntil = 0;
  }

  private accountColor(sim: Sim, ch: Character | undefined): string | undefined {
    return ch ? sim.accounts.get(ch.info.account)?.color : undefined;
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

    this.drawBrain(ctx, now, dark);
    this.spawnMemPulses(sim, now);
    this.drawRegions(ctx, dark);
    this.drawSynapses(ctx, sim, now);
    this.drawMemPulses(ctx, now);
    this.drawHippocampus(ctx, now, dark);

    // somas (sessões) e neurônios (subagentes) por profundidade; preenche heads p/ picking/hover
    const drawn = new Set<string>();
    const people = [...sim.chars.values()].filter((ch) => ch.visible && !ch.gone).sort((a, b) => a.y - b.y);
    for (const ch of people) {
      if (ch.info.kind === 'sub') this.drawNeuron(ctx, sim, ch, now, sel);
      else this.drawSoma(ctx, sim, ch, now, sel, dark);
      this.markHead(ch, heads);
      drawn.add(ch.id);
    }
    for (const [id, h] of heads) if (!drawn.has(id)) h.visible = false;
  }

  // ---------------------------------------------------------------- cérebro

  /** Contorno paramétrico do cérebro (top view, dois hemisférios) com giros; `t` em [0,2π). */
  private brainPoint(t: number): { x: number; y: number } {
    const { x: cx, y: cy } = this.center;
    const front = Math.max(0, -Math.sin(t)); // topo (frontal)
    const back = Math.max(0, Math.sin(t)); // base (occipital)
    // giros irregulares (bumps médios, não uma engrenagem regular)
    const gyri = 1 + 0.04 * Math.sin(9 * t + 0.5) + 0.028 * Math.sin(5 * t + 1.3) + 0.016 * Math.sin(14 * t);
    // entalhes no topo e na base do centro: realçam os DOIS hemisférios
    const g = (mu: number, s: number) => {
      let d = t - mu;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      return Math.exp(-(d * d) / (2 * s * s));
    };
    const notch = 1 - 0.1 * g(-Math.PI / 2, 0.16) - 0.07 * g(Math.PI / 2, 0.22);
    const taperTop = 1 - 0.08 * front; // frente mais estreita
    const widenBack = 1 + 0.05 * back; // occipital mais largo
    const r = gyri * notch;
    return {
      x: cx + Math.cos(t) * this.hw * r * taperTop * widenBack,
      y: cy + Math.sin(t) * this.hh * r * (back ? 0.9 : 1), // base levemente achatada
    };
  }

  private brainPath(ctx: CanvasRenderingContext2D): void {
    const steps = 160;
    ctx.beginPath();
    const p0 = this.brainPoint(0);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i <= steps; i++) {
      const p = this.brainPoint((i / steps) * Math.PI * 2);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  }

  private drawBrain(ctx: CanvasRenderingContext2D, now: number, dark: boolean): void {
    const { x: cx, y: cy } = this.center;
    const hw = this.hw;
    const hh = this.hh;

    // marca d'água: o próprio cérebro é a logo (bem discreta, atrás de tudo)
    if (this.logoReady && this.logo) {
      const lw = hw * 1.5;
      const lh = (lw * this.logo.height) / this.logo.width;
      ctx.save();
      ctx.globalAlpha = dark ? 0.05 : 0.06;
      ctx.drawImage(this.logo, cx - lw / 2, cy - lh / 2, lw, lh);
      ctx.restore();
    }

    ctx.save();
    // preenchimento
    const g = ctx.createRadialGradient(cx, cy - hh * 0.1, hw * 0.1, cx, cy, hw * 1.05);
    g.addColorStop(0, rgba(PURPLE, dark ? 0.2 : 0.14));
    g.addColorStop(0.65, rgba(PURPLE_DK, dark ? 0.12 : 0.08));
    g.addColorStop(1, rgba(PURPLE_DK, 0));
    ctx.fillStyle = g;
    this.brainPath(ctx);
    ctx.fill();

    // tecido cortical clipado dentro do cérebro
    this.brainPath(ctx);
    ctx.clip();
    this.drawSulci(ctx, dark);
    ctx.restore();

    // contorno com giros
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = rgba(dark ? LAVENDER : PURPLE_DK, dark ? 0.42 : 0.5);
    ctx.lineWidth = 3;
    this.brainPath(ctx);
    ctx.stroke();

    // fissura longitudinal central (separa os dois hemisférios)
    const breathe = Math.sin(now / 2400) * (hh * 0.01);
    ctx.strokeStyle = rgba(dark ? INK : PURPLE_DK, dark ? 0.55 : 0.4);
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx, cy - hh * 0.9);
    ctx.bezierCurveTo(cx - hw * 0.06, cy - hh * 0.3 + breathe, cx + hw * 0.06, cy + hh * 0.3 - breathe, cx, cy + hh * 0.86);
    ctx.stroke();
    ctx.strokeStyle = rgba(dark ? LAVENDER : MIST, 0.18);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // cerebelo: faixa de bolhas na base, reforça a leitura "cérebro"
    ctx.strokeStyle = rgba(dark ? LAVENDER : PURPLE_DK, dark ? 0.3 : 0.4);
    ctx.lineWidth = 2;
    for (let s = -1; s <= 1; s += 2) {
      ctx.beginPath();
      for (let k = 0; k <= 6; k++) {
        const a = (k / 6) * 0.9 + (s < 0 ? Math.PI - 0.1 : -0.8);
        const rx = hw * 0.34;
        const ry = hh * 0.2;
        const x = cx + Math.cos(a) * rx * s * 0 + (s * hw * 0.16) + Math.cos(a) * rx * 0.5;
        const y = cy + hh * 0.72 + Math.sin(a) * ry * 0.5;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Sulcos internos: poucas dobras curtas e orgânicas por hemisfério (dentro do clip do cérebro). */
  private drawSulci(ctx: CanvasRenderingContext2D, dark: boolean): void {
    const { x: cx, y: cy } = this.center;
    ctx.strokeStyle = rgba(dark ? LAVENDER : PURPLE_DK, dark ? 0.12 : 0.16);
    ctx.lineWidth = 2;
    for (let s = -1; s <= 1; s += 2) {
      for (let j = 0; j < 4; j++) {
        const off = (j + 1) / 5;
        const ex = cx + s * this.hw * (0.2 + off * 0.62);
        const span = this.hh * (0.34 - off * 0.05);
        const yc = cy + (j % 2 === 0 ? -1 : 1) * this.hh * 0.12;
        ctx.beginPath();
        ctx.moveTo(cx + s * this.hw * (0.14 + off * 0.1), yc - span);
        ctx.bezierCurveTo(ex, yc - span * 0.4, ex, yc + span * 0.4, cx + s * this.hw * (0.14 + off * 0.1), yc + span);
        ctx.stroke();
      }
    }
  }

  // ---------------------------------------------------------------- regiões (projetos)

  private blobPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, seed: number): void {
    const steps = 48;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const rr = r * (1 + 0.07 * Math.sin(7 * t + seed) + 0.04 * Math.sin(4 * t + seed * 0.5));
      const px = x + Math.cos(t) * rr;
      const py = y + Math.sin(t) * rr * 0.9;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  private drawRegions(ctx: CanvasRenderingContext2D, dark: boolean): void {
    for (const reg of this.regions.values()) {
      ctx.save();
      // tom próprio (preenchimento) + glow interno
      const g = ctx.createRadialGradient(reg.x, reg.y, reg.r * 0.2, reg.x, reg.y, reg.r);
      g.addColorStop(0, rgba(reg.color, dark ? 0.2 : 0.16));
      g.addColorStop(1, rgba(reg.color, 0.02));
      ctx.fillStyle = g;
      this.blobPath(ctx, reg.x, reg.y, reg.r, reg.seed);
      ctx.fill();
      // borda delimitada (giros da região)
      ctx.strokeStyle = rgba(reg.color, dark ? 0.6 : 0.7);
      ctx.lineWidth = 2.5;
      ctx.setLineDash([10, 6]);
      this.blobPath(ctx, reg.x, reg.y, reg.r, reg.seed);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // rótulo da pasta (pill com bolinha da conta)
      this.drawFolderLabel(ctx, reg, dark);
    }
  }

  private drawFolderLabel(ctx: CanvasRenderingContext2D, reg: Region, dark: boolean): void {
    ctx.save();
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(reg.name).width;
    const padX = 12;
    const w = tw + padX * 2 + 16;
    const h = 24;
    const x = reg.x - w / 2;
    const y = reg.y - reg.r * 0.9 - h - 4;
    ctx.fillStyle = rgba(dark ? '#201b33' : '#ffffff', 0.92);
    ctx.strokeStyle = rgba(reg.color, 0.8);
    ctx.lineWidth = 1.5;
    this.roundRect(ctx, x, y, w, h, 7);
    ctx.fill();
    ctx.stroke();
    // bolinha da conta
    ctx.fillStyle = reg.color;
    ctx.beginPath();
    ctx.arc(x + padX + 1, y + h / 2, 5, 0, Math.PI * 2);
    ctx.fill();
    // nome
    ctx.fillStyle = dark ? LAVENDER : INK;
    ctx.textAlign = 'left';
    ctx.fillText(reg.name, x + padX + 12, y + h / 2 + 0.5);
    ctx.restore();
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------------------------------------------------------------- hipocampo e memória

  private drawHippocampus(ctx: CanvasRenderingContext2D, now: number, dark: boolean): void {
    const { x, y } = this.center;
    const pulse = 0.5 + 0.5 * Math.sin(now / 900);
    const R = 24 + pulse * 3;
    ctx.save();
    const g = ctx.createRadialGradient(x, y, 2, x, y, R * 3);
    g.addColorStop(0, rgba(AMBER, 0.95));
    g.addColorStop(0.3, rgba(AMBER, 0.4));
    g.addColorStop(1, rgba(AMBER, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, R * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = rgba(AMBER, 0.7);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = rgba(AMBER, 0.3 + pulse * 0.3);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, R + 8 + pulse * 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = rgba('#fff4dd', 0.92);
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = rgba(dark ? AMBER : '#9a7320', 0.95);
    ctx.font = '600 12px system-ui, sans-serif';
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
      if (!op || !key || this.memSeen.get(ch.id) === key) continue;
      this.memSeen.set(ch.id, key);
      this.pulses.push({ x0: ch.x, y0: ch.y, start: now, dur: 1500, up: op === 'store' });
    }
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
      const k = p.up ? t : 1 - t;
      const x = lerp(p.x0, this.center.x, k);
      const y = lerp(p.y0, this.center.y, k);
      ctx.strokeStyle = rgba(AMBER, 0.18 * (1 - t));
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x0, p.y0);
      ctx.lineTo(this.center.x, this.center.y);
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

  // ---------------------------------------------------------------- sinapses

  private drawSynapses(ctx: CanvasRenderingContext2D, sim: Sim, now: number): void {
    ctx.save();
    for (const ch of sim.chars.values()) {
      if (ch.info.kind !== 'sub' || ch.gone) continue;
      const parent = ch.info.parentId ? sim.chars.get(ch.info.parentId) : undefined;
      if (!parent || parent.gone) continue;
      const color = sim.accounts.get(ch.info.account)?.color ?? PURPLE;
      const mx = (parent.x + ch.x) / 2 + (ch.y - parent.y) * 0.18;
      const my = (parent.y + ch.y) / 2 - (ch.x - parent.x) * 0.18;
      ctx.strokeStyle = rgba(color, 0.4);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(parent.x, parent.y);
      ctx.quadraticCurveTo(mx, my, ch.x, ch.y);
      ctx.stroke();
      const t = (((now / 1100) % 1) + ch.x * 0.0003) % 1;
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

  // ---------------------------------------------------------------- soma (sessão) e neurônio (subagente)

  private drawSoma(ctx: CanvasRenderingContext2D, sim: Sim, ch: Character, now: number, sel: { agent: string | null; hover: string | null }, dark: boolean): void {
    const acc = sim.accounts.get(ch.info.account);
    const color = acc?.color ?? PURPLE;
    const ph = phaseOf(ch);
    const selected = sel.agent === ch.id;
    const hovered = sel.hover === ch.id;
    const baseR = 30;
    const { speed, amp, bright } = ph === 'work' ? { speed: 640, amp: 0.14, bright: 1 } : ph === 'idle' ? { speed: 2600, amp: 0.06, bright: 0.6 } : ph === 'offline' ? { speed: 2600, amp: 0.03, bright: 0.32 } : { speed: 1600, amp: 0.1, bright: 0.85 };
    const pulse = 0.5 + 0.5 * Math.sin(now / speed + ch.x);
    const R = baseR * (1 + amp * pulse);
    const x = ch.x;
    const y = ch.y;

    ctx.save();
    this.drawDendrites(ctx, x, y, color, R, now, ph);

    // glow da conta
    const glow = ctx.createRadialGradient(x, y, R * 0.4, x, y, R * (ph === 'work' ? 3 : 2.3));
    glow.addColorStop(0, rgba(color, 0.55 * bright));
    glow.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, R * 3, 0, Math.PI * 2);
    ctx.fill();

    // disco do corpo (contraste para a logo)
    const body = ctx.createRadialGradient(x - R * 0.3, y - R * 0.3, 1, x, y, R);
    body.addColorStop(0, rgba(color, 0.95));
    body.addColorStop(1, dark ? rgba(INK, 0.95) : rgba(PURPLE_DK, 0.9));
    ctx.globalAlpha = ph === 'offline' ? 0.6 : 1;
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fill();
    // aro da conta
    ctx.globalAlpha = 1;
    ctx.strokeStyle = rgba(color, 0.95);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.stroke();

    // LOGO do Frinus dentro do soma (ou letra da conta como fallback)
    if (this.logoReady && this.logo) {
      const lw = R * 1.5;
      const lh = (lw * this.logo.height) / this.logo.width;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, R * 0.86, 0, Math.PI * 2);
      ctx.clip();
      ctx.globalAlpha = ph === 'offline' ? 0.5 : 0.95;
      ctx.drawImage(this.logo, x - lw / 2, y - lh / 2, lw, lh);
      ctx.restore();
    } else {
      ctx.fillStyle = luminance(color) > 0.6 ? INK : '#ffffff';
      ctx.font = `700 ${Math.round(R)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((acc?.short ?? '•').slice(0, 2), x, y + 0.5);
    }

    // badge com a LETRA da conta (canto inferior direito)
    const bx = x + R * 0.72;
    const by = y + R * 0.72;
    const br = Math.max(9, R * 0.44);
    ctx.fillStyle = color;
    ctx.strokeStyle = dark ? rgba(INK, 0.9) : rgba('#ffffff', 0.9);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = luminance(color) > 0.6 ? INK : '#ffffff';
    ctx.font = `700 ${Math.round(br * 1.05)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((acc?.short ?? '•').slice(0, 2), bx, by + 0.5);

    // faíscas quando trabalhando
    if (ph === 'work') {
      for (let i = 0; i < 3; i++) {
        const a = now / 300 + (i / 3) * Math.PI * 2 + ch.x;
        const rr = R * (1.5 + 0.3 * Math.sin(now / 200 + i));
        ctx.fillStyle = rgba('#fff6e0', 0.85);
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * rr, y + Math.sin(a) * rr, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (ph === 'done') {
      const fp = 0.5 + 0.5 * Math.sin(now / 420);
      ctx.strokeStyle = rgba(GREEN, 0.5 + fp * 0.4);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, R + 6 + fp * 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (ph === 'wait') {
      const blink = 0.4 + 0.6 * Math.abs(Math.sin(now / 420));
      ctx.strokeStyle = rgba(AMBER, blink);
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(x, y, R + 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = rgba(AMBER, blink);
      ctx.font = '700 15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🔑', x + R + 12, y - R - 6);
    }
    if (selected || hovered) {
      ctx.strokeStyle = rgba(selected ? MIST : LAVENDER, selected ? 0.95 : 0.6);
      ctx.lineWidth = selected ? 3.5 : 2.5;
      ctx.beginPath();
      ctx.arc(x, y, R + (selected ? 6 : 4), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawNeuron(ctx: CanvasRenderingContext2D, sim: Sim, ch: Character, now: number, sel: { agent: string | null; hover: string | null }): void {
    const color = sim.accounts.get(ch.info.account)?.color ?? PURPLE;
    const ph = phaseOf(ch);
    const selected = sel.agent === ch.id;
    const hovered = sel.hover === ch.id;
    const pulse = 0.5 + 0.5 * Math.sin(now / (ph === 'work' ? 560 : 1900) + ch.y);
    const R = 13 * (1 + 0.16 * pulse);
    const x = ch.x;
    const y = ch.y;
    ctx.save();
    this.drawDendrites(ctx, x, y, color, R, now, ph);
    const glow = ctx.createRadialGradient(x, y, R * 0.3, x, y, R * 2.6);
    glow.addColorStop(0, rgba(color, ph === 'offline' ? 0.2 : 0.55));
    glow.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, R * 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = rgba(color, ph === 'offline' ? 0.5 : 0.95);
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = rgba('#fff6ff', 0.9);
    ctx.beginPath();
    ctx.arc(x - R * 0.25, y - R * 0.25, R * 0.3, 0, Math.PI * 2);
    ctx.fill();
    if (ph === 'wait') {
      const blink = 0.4 + 0.6 * Math.abs(Math.sin(now / 420));
      ctx.strokeStyle = rgba(AMBER, blink);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, R + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (selected || hovered) {
      ctx.strokeStyle = rgba(selected ? MIST : LAVENDER, selected ? 0.95 : 0.6);
      ctx.lineWidth = selected ? 3 : 2;
      ctx.beginPath();
      ctx.arc(x, y, R + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawDendrites(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, R: number, now: number, ph: 'work' | 'wait' | 'done' | 'idle' | 'offline'): void {
    const n = R > 18 ? 5 : 3;
    const vibrate = ph === 'work' ? Math.sin(now / 90 + x) * 0.16 : 0;
    ctx.strokeStyle = rgba(color, ph === 'offline' ? 0.12 : 0.22);
    ctx.lineWidth = 1.3;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + y * 0.01 + vibrate;
      const len = R * (1.4 + (i % 2) * 0.4);
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * R, y + Math.sin(a) * R);
      ctx.quadraticCurveTo(x + Math.cos(a + 0.3) * len * 0.55, y + Math.sin(a + 0.3) * len * 0.55, x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
    }
  }

  private markHead(ch: Character, heads: Map<string, HeadInfo>): void {
    let h = heads.get(ch.id);
    if (!h) heads.set(ch.id, (h = { x: 0, y: 0, feetY: 0, visible: false, bx: 0, by: 0, bw: 0, bh: 0, depth: 0 }));
    const R = (ch.info.kind === 'sub' ? 15 : 34) + 4;
    h.x = ch.x;
    h.y = ch.y - R;
    h.feetY = ch.y + R;
    h.visible = true;
    h.bx = ch.x - R;
    h.by = ch.y - R;
    h.bw = R * 2;
    h.bh = R * 2;
    h.depth = ch.y;
  }
}
