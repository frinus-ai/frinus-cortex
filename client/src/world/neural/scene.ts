// Cena "Cérebro" (tema Frinus): a sensação de estar DENTRO de um grande cérebro.
// Não há uma silhueta de cérebro flutuando num fundo vazio — o próprio fundo É tecido
// cerebral, em camadas de profundidade: uma rede de neurônios distante e desfocada, giros
// e sulcos em grande escala, luz volumétrica e pulsos elétricos esparsos que ficam mais
// frequentes quando há agentes trabalhando (o cérebro "acende" com o trabalho).
//
// Sobre esse tecido vivem as REGIÕES (projetos) — áreas do córtex que se iluminam por dentro,
// integradas ao tecido (sem molduras). O Frinus é o núcleo (soma, com a logo legível) de cada
// região e os especialistas são neurônios ligados a ele por axônios de luz. No centro, discreto,
// o núcleo de memória recebe os pulsos âmbar de cada gravação/consulta.
//
// Desenha em coordenadas de mundo (transform da câmera): pan/zoom, enquadramento e picking
// (world/index.ts usa renderer.heads) continuam valendo sem tocar no server/rede/UI.
import type { Camera } from '../camera';
import type { HeadInfo } from '../render/renderer';
import type { Sim } from '../sim/sim';
import type { Character } from '../sim/character';
import type { WorldOptions } from '../api';
import { orbit } from './layout';
import { FRINUS_LOGO_WHITE_DATA_URL } from './logo';
import { reducedMotion } from '../render/github-fx';

/** Paleta do conceito (docs/planos/CONCEITO-frinus-cerebro.md). */
const CORTEX = '#0c0a16';
const PURPLE = '#6C3FC4';
const PURPLE_DK = '#5A32A8';
const LAVENDER = '#EFE9FB';
const MIST = '#F7F4FD';
const INK = '#1A1A2E';
const AMBER = '#E8B860';
const GREEN = '#8de0b0';

/** Raio do soma da sessão (Frinus) e do neurônio (especialista/subagente), em px de mundo. */
const SOMA_R = 46;
const NEURON_R = 22;
/** Distância da órbita dos especialistas ao redor da sessão (cresce com o nº de irmãos). */
const NEURON_ORBIT = 150;
const NEURON_ORBIT_PER_SIB = 8;

interface MemPulse {
  x0: number;
  y0: number;
  start: number;
  dur: number;
  up: boolean;
  color: string;
}

interface Region {
  x: number;
  y: number;
  r: number;
  color: string;
  name: string;
  seed: number;
  active: boolean;
}

/** Fibra distante do tecido (campo ambiente), em coordenadas normalizadas do viewport. */
interface Fiber {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  cx: number;
  cy: number;
  spd: number;
  off: number;
  amber: boolean;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
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
  /** Campo neural distante pré-renderizado em baixa resolução (blur barato ao escalar). */
  private far: HTMLCanvasElement | null = null;
  private fibers: Fiber[] = [];
  /** Intensidade de trabalho suavizada (0..1): o cérebro acende quando há agentes trabalhando. */
  private work = 0;

  constructor() {
    if (typeof Image !== 'undefined') {
      const img = new Image();
      img.onload = () => (this.logoReady = true);
      img.src = FRINUS_LOGO_WHITE_DATA_URL;
      this.logo = img;
    }
  }

  getBounds(): { x: number; y: number; w: number; h: number } | null {
    return this.bounds;
  }

  // ---------------------------------------------------------------- layout

  layout(sim: Sim, now: number): void {
    this.regions.clear();
    const still = reducedMotion();
    const spin = still ? 0 : now / 11000;
    const rooms = [...sim.rooms.values()].filter((r) => r.present).sort((a, b) => a.slot - b.slot);
    const n = Math.max(1, rooms.length);

    // O "campo" cresce um pouco com o nº de projetos; só serve de guia das órbitas e do enquadramento.
    this.hw = 700 + Math.min(260, n * 42);
    this.hh = this.hw * 0.74;
    this.center = { x: 0, y: 0 };

    const ringRx = this.hw * 0.5;
    const ringRy = this.hh * 0.52;
    const regionR = Math.max(72, Math.min(240, Math.min(this.hw, this.hh) * (n <= 2 ? 0.4 : n <= 4 ? 0.33 : n <= 6 ? 0.27 : 0.22)));

    rooms.forEach((room, i) => {
      const ang = -Math.PI / 2 + (i / n) * Math.PI * 2 + (n % 2 === 0 ? Math.PI / n : 0);
      const ax = n === 1 ? this.center.x : this.center.x + Math.cos(ang) * ringRx;
      const ay = n === 1 ? this.center.y - this.hh * 0.42 : this.center.y + Math.sin(ang) * ringRy;
      const mains = [...sim.chars.values()].filter((ch) => ch.roomId === room.id && ch.info.kind === 'main' && !ch.gone);
      const color = this.accountColor(sim, mains[0]) ?? PURPLE;
      const active = mains.some((ch) => phaseOf(ch) === 'work');
      this.regions.set(room.id, { x: ax, y: ay, r: regionR, color, name: room.info.name, seed: (room.seed ?? room.slot ?? i) >>> 0, active });
      const somaOrbit = Math.min(regionR * 0.5, 76);
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
      const radius = parent ? NEURON_ORBIT + Math.max(0, sibs.length - 2) * NEURON_ORBIT_PER_SIB : 180;
      const p = orbit(base.x, base.y, i, Math.max(2, sibs.length), radius, spin * 0.9 + 0.6);
      const s = ((ch.id.length * 7 + i * 13) % 17) / 17;
      const dx = still ? 0 : Math.sin(now / (1900 + s * 900) + i * 1.7) * 18;
      const dy = still ? 0 : Math.cos(now / (2300 + s * 700) + i * 2.3) * 14;
      this.place(ch, p.x + dx, p.y + dy);
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
    dt: number,
    opts: WorldOptions,
    sel: { agent: string | null; room: string | null; hover: string | null },
    heads: Map<string, HeadInfo>,
  ): void {
    const dark = opts.daylight !== 'day';
    const still = reducedMotion();
    const W = canvas.width;
    const H = canvas.height;

    // intensidade de trabalho (suavizada): quantos agentes estão trabalhando agora
    let working = 0;
    for (const ch of sim.chars.values()) {
      if (ch.gone) continue;
      if (phaseOf(ch) === 'work') working++;
    }
    const target = Math.min(1, working / 3);
    this.work += (target - this.work) * Math.min(1, Math.max(0.03, dt / 500));

    // --- fundo: tecido cerebral imersivo (espaço de tela, com parallax) ---
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    this.drawTissue(ctx, W, H, camera, now, dark, still);

    // --- mundo: regiões, memória, somas e neurônios ---
    const { scale, ox, oy } = camera.transform();
    ctx.setTransform(scale, 0, 0, scale, ox, oy);

    this.spawnMemPulses(sim, now);
    this.drawRegions(ctx, dark);
    this.drawMemoryCore(ctx, now, still);
    this.drawSynapses(ctx, sim, now, still);
    this.drawMemPulses(ctx, now);

    const drawn = new Set<string>();
    const people = [...sim.chars.values()].filter((ch) => ch.visible && !ch.gone).sort((a, b) => a.y - b.y);
    for (const ch of people) {
      if (ch.info.kind === 'sub') this.drawNeuron(ctx, sim, ch, now, sel, still);
      else this.drawSoma(ctx, sim, ch, now, sel, dark, still);
      this.markHead(ch, heads);
      drawn.add(ch.id);
    }
    for (const [id, h] of heads) if (!drawn.has(id)) h.visible = false;
  }

  // ---------------------------------------------------------------- tecido imersivo (fundo)

  /** Rede neural distante, pré-renderizada em baixa resolução: escalada para cima vira blur barato. */
  private buildFar(): void {
    if (typeof document === 'undefined') return;
    const FW = 460;
    const FH = 300;
    const c = document.createElement('canvas');
    c.width = FW;
    c.height = FH;
    const g = c.getContext('2d');
    if (!g) return;
    let s = 0x1a2e6c3f >>> 0;
    const rnd = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const N = 96;
    const nodes = Array.from({ length: N }, () => ({ x: rnd() * FW, y: rnd() * FH }));
    const near = 72;
    g.lineCap = 'round';
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const d = Math.hypot(dx, dy);
        if (d < near) {
          g.strokeStyle = rgba(i % 5 === 0 ? LAVENDER : PURPLE, (1 - d / near) * 0.28);
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(nodes[i].x, nodes[i].y);
          g.lineTo(nodes[j].x, nodes[j].y);
          g.stroke();
        }
      }
    }
    for (const nd of nodes) {
      const r = 1.6 + rnd() * 2.4;
      const gg = g.createRadialGradient(nd.x, nd.y, 0, nd.x, nd.y, r * 3);
      gg.addColorStop(0, rgba(LAVENDER, 0.6));
      gg.addColorStop(1, rgba(PURPLE, 0));
      g.fillStyle = gg;
      g.beginPath();
      g.arc(nd.x, nd.y, r * 3, 0, Math.PI * 2);
      g.fill();
    }
    this.far = c;
  }

  private buildFibers(): void {
    let s = 0x6c3fc4a1 >>> 0;
    const rnd = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    this.fibers = Array.from({ length: 14 }, (_, i) => {
      const edge = rnd();
      // fibras preferem as bordas/profundidade (longe do centro de atenção)
      const ax = edge < 0.5 ? rnd() * 0.3 : 0.7 + rnd() * 0.3;
      const ay = rnd();
      const bx = rnd();
      const by = rnd() < 0.5 ? rnd() * 0.25 : 0.75 + rnd() * 0.25;
      return {
        ax,
        ay,
        bx,
        by,
        cx: (ax + bx) / 2 + (rnd() - 0.5) * 0.4,
        cy: (ay + by) / 2 + (rnd() - 0.5) * 0.4,
        spd: 0.6 + rnd() * 0.8,
        off: rnd(),
        amber: i % 7 === 0,
      };
    });
  }

  private drawTissue(ctx: CanvasRenderingContext2D, W: number, H: number, camera: Camera, now: number, dark: boolean, still: boolean): void {
    const camX = camera.x;
    const camY = camera.y;
    const z = camera.zoom * camera.dpr;
    const cx = W / 2;
    const cy = H * 0.46;
    const breathe = still ? 0.5 : 0.5 + 0.5 * Math.sin(now / 5200);

    // base opaca + luz volumétrica no miolo (sobe com respiração e com o trabalho)
    ctx.fillStyle = dark ? CORTEX : LAVENDER;
    ctx.fillRect(0, 0, W, H);
    const lift = 0.05 * breathe + this.work * 0.12;
    const base = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.78);
    if (dark) {
      base.addColorStop(0, rgba(PURPLE, 0.14 + lift));
      base.addColorStop(0.4, rgba('#1a1430', 0.65));
      base.addColorStop(1, rgba(CORTEX, 0));
    } else {
      base.addColorStop(0, rgba(MIST, 0.6 + lift));
      base.addColorStop(0.5, rgba(LAVENDER, 0.4));
      base.addColorStop(1, rgba(LAVENDER, 0));
    }
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);

    // camada distante: rede neural desfocada, com parallax lento
    if (!this.far) this.buildFar();
    if (this.far) {
      const cover = Math.max(W, H) * 2.4;
      const par = 0.16;
      const drift = still ? 0 : Math.sin(now / 90000) * 40;
      const dx = cx - cover / 2 - camX * z * par + drift;
      const dy = cy - cover / 2 - camY * z * par;
      ctx.save();
      ctx.globalAlpha = dark ? 0.5 : 0.32;
      ctx.drawImage(this.far, dx, dy, cover, cover * (this.far.height / this.far.width));
      ctx.restore();
    }

    // giros/sulcos em grande escala (tecido cortical que transborda a viewport)
    this.drawGyri(ctx, W, H, camX, camY, z, now, dark, still);

    // pulsos elétricos esparsos em fibras distantes (mais frequentes quando há trabalho)
    this.drawAmbient(ctx, W, H, camX, camY, z, now, still);

    // vinheta: aprofunda as bordas e esconde as emendas das camadas
    const vg = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.28, cx, cy, Math.max(W, H) * 0.8);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, dark ? 'rgba(4,3,10,0.9)' : 'rgba(60,46,110,0.22)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
  }

  private drawGyri(ctx: CanvasRenderingContext2D, W: number, H: number, camX: number, camY: number, z: number, now: number, dark: boolean, still: boolean): void {
    ctx.save();
    const par = 0.4;
    ctx.translate(-camX * z * par, -camY * z * par);
    ctx.lineCap = 'round';
    const col = dark ? LAVENDER : PURPLE_DK;
    const rows = 7;
    for (let r = 0; r < rows; r++) {
      const y = (r / (rows - 1)) * (H * 1.4) - H * 0.2;
      const amp = 26 + (r % 3) * 12;
      const phase = r * 1.3;
      const wob = still ? 0 : Math.sin(now / 6000 + r) * 8;
      ctx.strokeStyle = rgba(col, dark ? 0.05 : 0.07);
      ctx.lineWidth = 10 + (r % 2) * 6;
      ctx.beginPath();
      let first = true;
      for (let x = -W * 0.3; x <= W * 1.3; x += 24) {
        const yy = y + Math.sin(x / 120 + phase) * amp + wob;
        if (first) {
          ctx.moveTo(x, yy);
          first = false;
        } else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawAmbient(ctx: CanvasRenderingContext2D, W: number, H: number, camX: number, camY: number, z: number, now: number, still: boolean): void {
    if (!this.fibers.length) this.buildFibers();
    const active = still ? 0 : Math.min(this.fibers.length, 2 + Math.round(this.work * 9));
    ctx.save();
    const par = 0.5;
    ctx.translate(-camX * z * par, -camY * z * par);
    for (let i = 0; i < this.fibers.length; i++) {
      const f = this.fibers[i];
      const ax = f.ax * W;
      const ay = f.ay * H;
      const bx = f.bx * W;
      const by = f.by * H;
      const cx = f.cx * W;
      const cy = f.cy * H;
      ctx.strokeStyle = rgba(f.amber ? AMBER : PURPLE, 0.06);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(cx, cy, bx, by);
      ctx.stroke();
      if (i < active) {
        const t = (((now / (1900 - this.work * 650)) * f.spd + f.off) % 1 + 1) % 1;
        const px = (1 - t) * (1 - t) * ax + 2 * (1 - t) * t * cx + t * t * bx;
        const py = (1 - t) * (1 - t) * ay + 2 * (1 - t) * t * cy + t * t * by;
        const col = f.amber ? AMBER : LAVENDER;
        const g = ctx.createRadialGradient(px, py, 0, px, py, 5);
        g.addColorStop(0, rgba('#ffffff', 0.8));
        g.addColorStop(0.5, rgba(col, 0.6));
        g.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
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

  /** Região = área do córtex que se ilumina por dentro, integrada ao tecido (sem molduras). */
  private drawRegions(ctx: CanvasRenderingContext2D, dark: boolean): void {
    for (const reg of this.regions.values()) {
      ctx.save();
      const boost = reg.active ? 0.1 : 0;
      const g = ctx.createRadialGradient(reg.x, reg.y - reg.r * 0.12, reg.r * 0.12, reg.x, reg.y, reg.r);
      g.addColorStop(0, rgba(reg.color, (dark ? 0.26 : 0.2) + boost));
      g.addColorStop(0.6, rgba(reg.color, (dark ? 0.1 : 0.08) + boost * 0.5));
      g.addColorStop(1, rgba(reg.color, 0));
      ctx.fillStyle = g;
      this.blobPath(ctx, reg.x, reg.y, reg.r, reg.seed);
      ctx.fill();
      // contorno contínuo finíssimo (definição sutil, nunca uma moldura)
      ctx.strokeStyle = rgba(reg.color, dark ? 0.18 : 0.24);
      ctx.lineWidth = 1.25;
      this.blobPath(ctx, reg.x, reg.y, reg.r, reg.seed);
      ctx.stroke();
      ctx.restore();

      this.drawFolderLabel(ctx, reg, dark);
    }
  }

  private drawFolderLabel(ctx: CanvasRenderingContext2D, reg: Region, dark: boolean): void {
    ctx.save();
    ctx.font = '600 14px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(reg.name).width;
    const padX = 11;
    const w = tw + padX * 2 + 14;
    const hh = 23;
    const x = reg.x - w / 2;
    const y = reg.y - reg.r * 0.92 - hh - 2;
    ctx.fillStyle = rgba(dark ? '#17132a' : '#ffffff', dark ? 0.72 : 0.9);
    this.roundRect(ctx, x, y, w, hh, 11);
    ctx.fill();
    ctx.fillStyle = reg.color;
    ctx.beginPath();
    ctx.arc(x + padX + 1, y + hh / 2, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = dark ? rgba(LAVENDER, 0.92) : INK;
    ctx.textAlign = 'left';
    ctx.fillText(reg.name, x + padX + 11, y + hh / 2 + 0.5);
    ctx.restore();
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  // ---------------------------------------------------------------- núcleo de memória

  /** Núcleo de memória: um brilho âmbar discreto no centro, integrado ao tecido (recebe os pulsos). */
  private drawMemoryCore(ctx: CanvasRenderingContext2D, now: number, still: boolean): void {
    const { x, y } = this.center;
    const b = still ? 0.6 : 0.5 + 0.5 * Math.sin(now / 2600);
    const R = 76;
    const g = ctx.createRadialGradient(x, y, 0, x, y, R);
    g.addColorStop(0, rgba(AMBER, 0.2 + 0.1 * b));
    g.addColorStop(0.5, rgba(AMBER, 0.06));
    g.addColorStop(1, rgba(AMBER, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fill();
    const g2 = ctx.createRadialGradient(x, y, 0, x, y, 11);
    g2.addColorStop(0, rgba('#fff2d6', 0.6 + 0.2 * b));
    g2.addColorStop(1, rgba(AMBER, 0));
    ctx.fillStyle = g2;
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.fill();
  }

  private spawnMemPulses(sim: Sim, now: number): void {
    for (const ch of sim.chars.values()) {
      if (ch.gone) continue;
      const op = memOp(ch);
      const key = ch.info.activity?.id ?? '';
      if (!op || !key || this.memSeen.get(ch.id) === key) continue;
      this.memSeen.set(ch.id, key);
      const color = sim.accounts.get(ch.info.account)?.color ?? PURPLE;
      this.pulses.push({ x0: ch.x, y0: ch.y, start: now, dur: 1500, up: op === 'store', color });
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
      ctx.strokeStyle = rgba(AMBER, 0.16 * (1 - t));
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

  // ---------------------------------------------------------------- axônios (especialista → Frinus)

  /** Cada especialista projeta um axônio de luz até a soma do Frinus; um sinal percorre quando trabalha. */
  private drawSynapses(ctx: CanvasRenderingContext2D, sim: Sim, now: number, still: boolean): void {
    ctx.save();
    ctx.lineCap = 'round';
    for (const ch of sim.chars.values()) {
      if (ch.info.kind !== 'sub' || ch.gone) continue;
      const parent = ch.info.parentId ? sim.chars.get(ch.info.parentId) : undefined;
      if (!parent || parent.gone) continue;
      const color = sim.accounts.get(ch.info.account)?.color ?? PURPLE;
      const toward = Math.atan2(parent.y - ch.y, parent.x - ch.x);
      // sai da borda do neurônio e chega na borda da soma
      const p0 = { x: ch.x + Math.cos(toward) * NEURON_R * 0.9, y: ch.y + Math.sin(toward) * NEURON_R * 0.9 };
      const p2 = { x: parent.x - Math.cos(toward) * SOMA_R * 0.95, y: parent.y - Math.sin(toward) * SOMA_R * 0.95 };
      const mx = (p0.x + p2.x) / 2 + (p2.y - p0.y) * 0.16;
      const my = (p0.y + p2.y) / 2 - (p2.x - p0.x) * 0.16;
      const at = (t: number) => ({
        x: (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * mx + t * t * p2.x,
        y: (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * my + t * t * p2.y,
      });
      ctx.strokeStyle = rgba(color, 0.42);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.quadraticCurveTo(mx, my, p2.x, p2.y);
      ctx.stroke();
      // bainha de mielina (segmentos claros com nódulos entre eles)
      ctx.strokeStyle = rgba(LAVENDER, 0.3);
      ctx.lineWidth = 4;
      for (let s = 0; s < 4; s++) {
        const t0 = 0.16 + s * 0.17;
        const a = at(t0);
        const b = at(t0 + 0.1);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      // potencial de ação viajando até a soma (quando o especialista trabalha)
      if (!still && phaseOf(ch) === 'work') {
        const t = ((now / 900 + ch.x * 0.0003) % 1 + 1) % 1;
        const p = at(t);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 6);
        g.addColorStop(0, rgba('#ffffff', 0.9));
        g.addColorStop(0.5, rgba(color, 0.8));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- soma (Frinus) e neurônio (especialista)

  private drawSoma(ctx: CanvasRenderingContext2D, sim: Sim, ch: Character, now: number, sel: { agent: string | null; hover: string | null }, dark: boolean, still: boolean): void {
    const acc = sim.accounts.get(ch.info.account);
    const color = acc?.color ?? PURPLE;
    const ph = phaseOf(ch);
    const selected = sel.agent === ch.id;
    const hovered = sel.hover === ch.id;
    const x = ch.x;
    const y = ch.y;

    // estado claro: trabalhando (halo que pulsa devagar), ocioso (parado), precisa de você (âmbar)
    const slow = still ? 0.5 : 0.5 + 0.5 * Math.sin(now / 1500 + x * 0.01);
    const calm = still ? 0.3 : 0.5 + 0.5 * Math.sin(now / 3600 + x * 0.01);
    let haloColor = color;
    let haloAmt: number;
    let bright: number;
    let R = SOMA_R;
    if (ph === 'work') {
      haloAmt = 0.4 + 0.4 * slow;
      bright = 1;
      R = SOMA_R * (1 + 0.05 * slow);
    } else if (ph === 'wait') {
      haloColor = AMBER;
      haloAmt = 0.4 + 0.45 * (still ? 0.5 : Math.abs(Math.sin(now / 620)));
      bright = 0.95;
    } else if (ph === 'done') {
      haloAmt = 0.4;
      bright = 0.9;
    } else if (ph === 'offline') {
      haloAmt = 0.1;
      bright = 0.42;
    } else {
      haloAmt = 0.2 + 0.12 * calm;
      bright = 0.72;
    }

    ctx.save();
    this.drawDendrites(ctx, x, y, color, R, now, ph, still);

    // halo
    const glow = ctx.createRadialGradient(x, y, R * 0.5, x, y, R * (ph === 'work' || ph === 'wait' ? 3 : 2.3));
    glow.addColorStop(0, rgba(haloColor, haloAmt * bright));
    glow.addColorStop(1, rgba(haloColor, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, R * 3, 0, Math.PI * 2);
    ctx.fill();

    // corpo do orbe (gradiente na cor da conta → tinta, para a logo branca ressaltar)
    const body = ctx.createRadialGradient(x - R * 0.32, y - R * 0.34, 1, x, y, R);
    body.addColorStop(0, rgba(color, 0.98));
    body.addColorStop(0.7, rgba(color, 0.9));
    body.addColorStop(1, dark ? rgba(INK, 0.96) : rgba(PURPLE_DK, 0.94));
    ctx.globalAlpha = ph === 'offline' ? 0.6 : 1;
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // aro fino na cor da conta
    ctx.strokeStyle = rgba(color, 0.9);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.stroke();
    // brilho especular superior (dá volume ao orbe)
    const spec = ctx.createLinearGradient(x, y - R, x, y);
    spec.addColorStop(0, rgba('#ffffff', 0.22));
    spec.addColorStop(1, rgba('#ffffff', 0));
    ctx.fillStyle = spec;
    ctx.beginPath();
    ctx.arc(x, y, R * 0.98, Math.PI, Math.PI * 2);
    ctx.fill();

    // LOGO do Frinus (branca + ∞ lavanda) legível dentro do orbe
    if (this.logoReady && this.logo) {
      const lw = R * 1.62;
      const lh = (lw * this.logo.height) / this.logo.width;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, R * 0.9, 0, Math.PI * 2);
      ctx.clip();
      ctx.globalAlpha = ph === 'offline' ? 0.55 : 1;
      ctx.drawImage(this.logo, x - lw / 2, y - lh / 2, lw, lh);
      ctx.restore();
    }

    // anéis de estado (discretos)
    if (ph === 'done') {
      const fp = still ? 0.6 : 0.5 + 0.5 * Math.sin(now / 420);
      ctx.strokeStyle = rgba(GREEN, 0.45 + fp * 0.4);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, R + 6 + fp * 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (ph === 'wait') {
      const blink = still ? 0.7 : 0.4 + 0.6 * Math.abs(Math.sin(now / 620));
      ctx.strokeStyle = rgba(AMBER, blink);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, R + 8, 0, Math.PI * 2);
      ctx.stroke();
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

  private drawNeuron(ctx: CanvasRenderingContext2D, sim: Sim, ch: Character, now: number, sel: { agent: string | null; hover: string | null }, still: boolean): void {
    const color = sim.accounts.get(ch.info.account)?.color ?? PURPLE;
    const ph = phaseOf(ch);
    const selected = sel.agent === ch.id;
    const hovered = sel.hover === ch.id;
    const pulse = still ? 0.5 : 0.5 + 0.5 * Math.sin(now / (ph === 'work' ? 560 : 1900) + ch.y);
    const R = NEURON_R * (1 + 0.1 * pulse);
    const x = ch.x;
    const y = ch.y;
    const parent = ch.info.parentId ? sim.chars.get(ch.info.parentId) : undefined;
    // o axônio vai até a soma do Frinus; os dendritos se abrem para o lado oposto
    const away = parent ? Math.atan2(y - parent.y, x - parent.x) : -Math.PI / 2;
    const seed = (ch.id.charCodeAt(0) || 7) * 0.37 + ch.id.length;
    const alpha = ph === 'offline' ? 0.45 : 1;

    ctx.save();
    const glow = ctx.createRadialGradient(x, y, R * 0.3, x, y, R * 3.2);
    glow.addColorStop(0, rgba(color, ph === 'offline' ? 0.16 : ph === 'work' ? 0.5 : 0.4));
    glow.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, R * 3.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = alpha;
    this.drawNeuronDendrites(ctx, x, y, R, away, seed, color, now, ph, still);

    // corpo celular (soma piramidal, contorno levemente irregular)
    const body = ctx.createRadialGradient(x - R * 0.3, y - R * 0.3, 1, x, y, R * 1.1);
    body.addColorStop(0, rgba('#ffffff', 0.55));
    body.addColorStop(0.35, rgba(color, 0.95));
    body.addColorStop(1, rgba(PURPLE_DK, 0.95));
    ctx.fillStyle = body;
    ctx.beginPath();
    const steps = 28;
    for (let k = 0; k <= steps; k++) {
      const t = (k / steps) * Math.PI * 2;
      const lobes = 0.16 * Math.cos(3 * (t - away)) + 0.06 * Math.sin(5 * t + seed);
      const rr = R * (1 + lobes + (still ? 0 : 0.03 * Math.sin(now / 700 + t * 2)));
      const px = x + Math.cos(t) * rr;
      const py = y + Math.sin(t) * rr;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.95);
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // núcleo + nucléolo
    ctx.fillStyle = rgba(INK, 0.5);
    ctx.beginPath();
    ctx.ellipse(x, y, R * 0.42, R * 0.36, away, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = rgba('#fff6ff', 0.9);
    ctx.beginPath();
    ctx.arc(x + R * 0.08, y - R * 0.06, R * 0.14, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    if (ph === 'wait') {
      const blink = still ? 0.7 : 0.4 + 0.6 * Math.abs(Math.sin(now / 620));
      ctx.strokeStyle = rgba(AMBER, blink);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, R + 7, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (ph === 'done') {
      const fp = still ? 0.6 : 0.5 + 0.5 * Math.sin(now / 420);
      ctx.strokeStyle = rgba(GREEN, 0.45 + fp * 0.4);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, R + 6 + fp * 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (selected || hovered) {
      ctx.strokeStyle = rgba(selected ? MIST : LAVENDER, selected ? 0.95 : 0.6);
      ctx.lineWidth = selected ? 3 : 2;
      ctx.beginPath();
      ctx.arc(x, y, R + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Árvore dendrítica: troncos que se bifurcam (2 níveis) e terminam em botões; ondulam ao trabalhar. */
  private drawNeuronDendrites(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, away: number, seed: number, color: string, now: number, ph: 'work' | 'wait' | 'done' | 'idle' | 'offline', still: boolean): void {
    const sway = still ? 0 : ph === 'work' ? 0.12 : 0.05;
    const trunks = 5;
    ctx.lineCap = 'round';
    const branch = (x0: number, y0: number, ang: number, len: number, w: number, depth: number, k: number): void => {
      const wob = still ? 0 : Math.sin(now / (ph === 'work' ? 260 : 900) + seed + k * 1.9) * sway;
      const a = ang + wob;
      const x1 = x0 + Math.cos(a) * len;
      const y1 = y0 + Math.sin(a) * len;
      const cx = x0 + Math.cos(a + 0.25) * len * 0.55;
      const cy = y0 + Math.sin(a + 0.25) * len * 0.55;
      ctx.strokeStyle = rgba(color, 0.75 - depth * 0.18);
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(cx, cy, x1, y1);
      ctx.stroke();
      if (depth < 2) {
        const spread = 0.42 + 0.1 * Math.sin(seed + k);
        branch(x1, y1, a - spread, len * 0.62, w * 0.62, depth + 1, k * 2 + 1);
        branch(x1, y1, a + spread, len * 0.55, w * 0.62, depth + 1, k * 2 + 2);
      } else {
        ctx.fillStyle = rgba(color, 0.8);
        ctx.beginPath();
        ctx.arc(x1, y1, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    for (let i = 0; i < trunks; i++) {
      // os troncos se abrem no lado OPOSTO ao axônio (que vai para a soma) — leque de ~250°
      const a = away + ((i / (trunks - 1)) - 0.5) * 4.4 + 0.15 * Math.sin(seed * (i + 1));
      const len = R * (1.05 + 0.35 * ((i * 7 + Math.round(seed)) % 3) / 2);
      branch(x + Math.cos(a) * R * 0.85, y + Math.sin(a) * R * 0.85, a, len, 3.2, 0, i);
    }
  }

  private drawDendrites(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, R: number, now: number, ph: 'work' | 'wait' | 'done' | 'idle' | 'offline', still: boolean): void {
    const n = R > 18 ? 5 : 3;
    const vibrate = !still && ph === 'work' ? Math.sin(now / 90 + x) * 0.16 : 0;
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
    const R = (ch.info.kind === 'sub' ? NEURON_R + 6 : SOMA_R + 6) + 4;
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
