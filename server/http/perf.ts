// Painel "Desempenho" (GET /api/perf): quanto a máquina aguenta e quanto cada sessão/trabalho está consumindo.
//
// O servidor lê o sistema (RAM, processador, swap, PSI de memória/CPU) e, no Linux rodando limitado por cgroup v2, o
// teto do próprio Córtex. Um amostrador em segundo plano (a cada ~2,5 s, só os arquivos baratos de /proc — sem varrer
// processo nenhum) mantém um histórico curto em memória e calcula o semáforo com histerese de ~10 s. A árvore de
// processos de cada sessão (memória e processador somados do principal + filhos, ex.: servidores MCP) é medida só a
// cada GET, porque exige varrer /proc.
//
// Mesma exposição de GET /api/snapshot e /api/stats: só números agregados e nomes de projeto/conta/agente que o
// escritório já mostra. Nada de ler ou encerrar processo: o painel só informa; abrir, pausar ou fechar é sempre o
// usuário quem decide, com um clique.
//
// As funções de cálculo (orçamento, semáforo) e os parsers de /proc são puros e testados em http/perf.test.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import type { PerfBudget, PerfCortexCap, PerfLevel, PerfPlatform, PerfSessionInfo, PerfSnapshot, PerfSystem, PerfWeight } from '../../shared/types';
import { tr } from '../../shared/i18n';

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
/** Clock ticks por segundo no Linux (campos utime/stime de /proc/<pid>/stat vêm em ticks). */
const CLOCK_TICKS = 100;
/** Quanto tempo o amostrador espera entre leituras do sistema. */
const SAMPLE_MS = 2500;
/** Histórico mantido em memória (para "sustentado 15 s" e swap crescendo). */
const HISTORY_MS = 30_000;
/** Recuperar para um nível melhor exige a condição se manter por este tempo (histerese). */
const RECOVER_MS = 10_000;
/** 🔴 por PSI de memória alto só dispara se ele se mantém por este tempo. */
const PSI_SUSTAIN_MS = 15_000;

// ---------------------------------------------------------------------------------------------------------- orçamento

/** Reserva do sistema: o maior entre 2 GB e 25% da RAM. */
export function reserveBytes(ramBytes: number): number {
  return Math.max(2 * GB, Math.floor(ramBytes * 0.25));
}

/**
 * Quantos trabalhos cabem com folga. reserva = max(2 GB, 25% RAM); orçamento = RAM − reserva;
 * sessões_max = floor((orçamento − 200 MB) / 1,2 GB), mínimo 1.
 */
export function computeBudget(ramBytes: number, sessionsActive: number): PerfBudget {
  const reserve = reserveBytes(ramBytes);
  const budget = Math.max(0, ramBytes - reserve);
  const sessionsMax = Math.max(1, Math.floor((budget - 200 * MB) / (1.2 * GB)));
  return {
    reserveMb: Math.round(reserve / MB),
    budgetMb: Math.round(budget / MB),
    sessionsMax,
    sessionsActive,
    freeSessions: sessionsMax - sessionsActive,
  };
}

/** Peso leigo de uma sessão pela memória: leve (<600 MB) · médio (<1200 MB) · pesado. */
export function weightOf(memMb: number): PerfWeight {
  if (memMb < 600) return 'light';
  if (memMb < 1200) return 'medium';
  return 'heavy';
}

// ---------------------------------------------------------------------------------------------------------- semáforo

export interface SemaphoreInput {
  /** % da RAM em uso (0–100). */
  memUsedPct: number;
  /** % de processador em uso (0–100). */
  cpuPct: number;
  /** PSI de memória "some avg10" (0–100), quando existe. */
  psiMemAvg10?: number;
  /** memory.current / min(memory.high, memory.max) do cgroup do Córtex (0–1), quando existe. */
  cgroupRatio?: number;
  /** Swap em uso agora, em MB. */
  swapUsedMb: number;
}

export interface PerfSample extends SemaphoreInput {
  at: number;
}

const RANK: Record<PerfLevel, number> = { green: 0, yellow: 1, red: 2 };

/** O swap está crescendo? (usado e maior há ~10 s do que no começo da janela, com margem contra ruído). */
export function swapGrowing(history: readonly PerfSample[], now: number): boolean {
  if (!history.length) return false;
  const cur = history[history.length - 1].swapUsedMb;
  if (cur <= 64) return false; // swap irrisório: ignora
  const past = history.find((s) => now - s.at <= HISTORY_MS && now - s.at >= RECOVER_MS);
  if (!past) return false;
  return cur - past.swapUsedMb >= 32;
}

/** O PSI de memória passou de 20 de forma sustentada por ≥ 15 s? (precisa de histórico cobrindo a janela). */
export function psiSustainedRed(history: readonly PerfSample[], now: number): boolean {
  const window = history.filter((s) => now - s.at <= PSI_SUSTAIN_MS);
  if (!window.length) return false;
  if (now - window[0].at < PSI_SUSTAIN_MS - SAMPLE_MS) return false; // ainda não há 15 s de dados
  return window.every((s) => (s.psiMemAvg10 ?? 0) > 20);
}

/** Nível instantâneo pelas regras cruas (sem histerese). */
export function instantLevel(s: SemaphoreInput, history: readonly PerfSample[], now: number): PerfLevel {
  const psi = s.psiMemAvg10 ?? 0;
  const red =
    s.memUsedPct > 85 ||
    (s.cgroupRatio !== undefined && s.cgroupRatio >= 0.9) ||
    swapGrowing(history, now) ||
    psiSustainedRed(history, now);
  if (red) return 'red';
  const green = s.memUsedPct < 70 && s.cpuPct < 75 && psi <= 10;
  return green ? 'green' : 'yellow';
}

/**
 * Nível relatado com histerese: piorar é imediato; melhorar exige o nível instantâneo se manter melhor por ≥ 10 s.
 * `betterSince` guarda desde quando o instantâneo está abaixo do relatado (null = não está). Devolve o novo estado.
 */
export function reportedLevel(
  prev: PerfLevel,
  betterSince: number | null,
  instant: PerfLevel,
  now: number,
): { level: PerfLevel; betterSince: number | null } {
  if (RANK[instant] > RANK[prev]) return { level: instant, betterSince: null }; // piorou: na hora
  if (RANK[instant] === RANK[prev]) return { level: prev, betterSince: null };
  // Instantâneo melhor que o relatado: só desce depois de se manter por RECOVER_MS.
  const since = betterSince ?? now;
  if (now - since >= RECOVER_MS) return { level: instant, betterSince: null };
  return { level: prev, betterSince: since };
}

/** Frase leiga para o semáforo. `free` = folga de sessões (sessões_max − ativas). */
export function laySummary(level: PerfLevel, free: number): string {
  if (level === 'red') return tr('Máquina sobrecarregada — considere pausar ou fechar um trabalho pesado.');
  if (level === 'yellow') {
    if (free <= 0) return tr('A máquina está ficando cheia — evite abrir trabalhos pesados agora.');
    return tr('Começando a encher — dá para abrir mais {0}, mas com cuidado.', [free === 1 ? tr('1 trabalho') : tr('{0} trabalhos', [free])]);
  }
  if (free <= 0) return tr('Tudo tranquilo, mas a máquina já está no limite de trabalhos.');
  return tr('Tudo tranquilo — {0}.', [free === 1 ? tr('cabe mais 1 trabalho') : tr('cabem mais {0} trabalhos', [free])]);
}

// ---------------------------------------------------------------------------------------------------- parsers /proc

/** /proc/meminfo → kB de total, disponível e swap. */
export function parseMeminfo(text: string): { memTotalKb: number; memAvailableKb: number; swapTotalKb: number; swapFreeKb: number } {
  const get = (key: string): number => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) : 0;
  };
  return { memTotalKb: get('MemTotal'), memAvailableKb: get('MemAvailable'), swapTotalKb: get('SwapTotal'), swapFreeKb: get('SwapFree') };
}

/** /proc/pressure/memory|cpu → "some avg10" (undefined se não der para ler). */
export function parsePressureAvg10(text: string): number | undefined {
  const m = /^some\s+.*\bavg10=([\d.]+)/m.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** Linha agregada "cpu" de /proc/stat → jiffies totais e ociosos (idle + iowait). */
export function parseProcStat(text: string): { total: number; idle: number } | undefined {
  const m = /^cpu\s+(.+)$/m.exec(text);
  if (!m) return undefined;
  const n = m[1].trim().split(/\s+/).map(Number);
  if (n.length < 5 || n.some((x) => !Number.isFinite(x))) return undefined;
  const idle = n[3] + (n[4] ?? 0); // idle + iowait
  const total = n.reduce((a, b) => a + b, 0);
  return { total, idle };
}

/** % de processador em uso entre duas leituras de /proc/stat. */
export function cpuPercentFromDelta(prev: { total: number; idle: number }, cur: { total: number; idle: number }): number {
  const dTotal = cur.total - prev.total;
  const dIdle = cur.idle - prev.idle;
  if (dTotal <= 0) return 0;
  return clampPct(((dTotal - dIdle) / dTotal) * 100);
}

/** Valor de um arquivo de cgroup v2 ("max" → null; número em bytes). */
export function parseCgroupValue(text: string): number | null {
  const s = text.trim();
  if (s === 'max' || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Caminho do próprio cgroup a partir de /proc/self/cgroup (formato v2: "0::/caminho"). */
export function parseSelfCgroup(text: string): string | undefined {
  const m = /^0::(.+)$/m.exec(text.trim());
  return m ? m[1].trim() : undefined;
}

export interface ProcStat {
  pid: number;
  ppid: number;
  /** utime + stime, em clock ticks. */
  jiffies: number;
  /** RSS em páginas. */
  rssPages: number;
}

/**
 * /proc/<pid>/stat → ppid, jiffies (utime+stime) e RSS em páginas. O 2º campo (comm) vem entre parênteses e pode ter
 * espaços e parênteses: corta do último ')' e conta a partir dali. Campos (1-based a partir do ')'): [0]=ppid(4),
 * [11]=utime(14), [12]=stime(15), [21]=rss(24).
 */
export function parseProcPidStat(text: string, pid: number): ProcStat | undefined {
  const close = text.lastIndexOf(')');
  if (close < 0) return undefined;
  const rest = text.slice(close + 2).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const rssPages = Number(rest[21]);
  if ([ppid, utime, stime, rssPages].some((x) => !Number.isFinite(x))) return undefined;
  return { pid, ppid, jiffies: utime + stime, rssPages };
}

/** `ps -A -o pid,ppid,rss,%cpu` (macOS) → mapa pid → {ppid, rssKb, cpu}. Pula o cabeçalho. */
export function parsePsAll(text: string): Map<number, { ppid: number; rssKb: number; cpu: number }> {
  const out = new Map<number, { ppid: number; rssKb: number; cpu: number }>();
  for (const line of text.split('\n').slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 4) continue;
    const pid = Number(p[0]);
    const ppid = Number(p[1]);
    const rssKb = Number(p[2]);
    const cpu = Number(p[3]);
    if ([pid, ppid, rssKb, cpu].some((x) => !Number.isFinite(x))) continue;
    out.set(pid, { ppid, rssKb, cpu });
  }
  return out;
}

/** Descendentes de `root` (inclusive) num mapa pid → ppid. */
export function descendants(root: number, children: Map<number, number[]>): number[] {
  const out: number[] = [];
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return out;
}

/** ppid → filhos a partir de qualquer mapa com ppid. */
export function childIndex<T extends { ppid: number }>(byPid: Map<number, T>): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const [pid, info] of byPid) {
    const arr = children.get(info.ppid) ?? [];
    arr.push(pid);
    children.set(info.ppid, arr);
  }
  return children;
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 100 ? 100 : n;
}

// --------------------------------------------------------------------------------------------------------- plataforma

/** linux | wsl | darwin | other. WSL: /proc/version com "microsoft" ou WSL_DISTRO_NAME. */
export function detectPlatform(platform: NodeJS.Platform, procVersion: string | undefined, env: Record<string, string | undefined>): PerfPlatform {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') {
    if (env.WSL_DISTRO_NAME || /microsoft/i.test(procVersion ?? '')) return 'wsl';
    return 'linux';
  }
  return 'other';
}

// ------------------------------------------------------------------------------------------------------------ monitor

/** De onde o monitor tira as sessões ativas (o office/PTY manager preenche no server/index.ts). */
export interface PerfSessionRef {
  pid: number;
  name: string;
  project: string;
  account: string;
}

export interface PerfMonitorOptions {
  sessions: () => PerfSessionRef[];
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

/**
 * Lê o sistema e as sessões e monta o PerfSnapshot. O amostrador barato roda em segundo plano; a varredura das árvores
 * de processos acontece só em `snapshot()` (a cada GET). Guarde um só por servidor e chame `stop()` no encerramento.
 */
export class PerfMonitor {
  private readonly getSessions: () => PerfSessionRef[];
  private readonly platform: NodeJS.Platform;
  private readonly perfPlatform: PerfPlatform;
  private readonly now: () => number;
  private readonly history: PerfSample[] = [];
  private level: PerfLevel = 'green';
  private betterSince: number | null = null;
  private lastSample?: PerfSample;
  private prevCpu?: { total: number; idle: number };
  private cpuPct = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cgroupPath?: string;
  private cgroupResolved = false;
  /** jiffies da árvore de cada sessão na varredura anterior, para o % de processador (Linux). */
  private treeCpu = new Map<number, { jiffies: number; at: number }>();

  constructor(opts: PerfMonitorOptions) {
    this.getSessions = opts.sessions;
    this.platform = opts.platform ?? process.platform;
    const env = opts.env ?? process.env;
    let procVersion: string | undefined;
    try {
      procVersion = this.platform === 'linux' ? readFileSync('/proc/version', 'utf8') : undefined;
    } catch {
      procVersion = undefined;
    }
    this.perfPlatform = detectPlatform(this.platform, procVersion, env);
    this.now = opts.now ?? Date.now;
  }

  /** Liga o amostrador em segundo plano (idempotente). Não segura o processo vivo (unref). */
  start(): void {
    if (this.timer) return;
    void this.sampleSystem();
    this.timer = setInterval(() => void this.sampleSystem(), SAMPLE_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Lê só os arquivos baratos do sistema, atualiza o histórico e recalcula o semáforo com histerese. */
  private async sampleSystem(): Promise<void> {
    try {
      const sys = await this.readSystem();
      this.lastSys = sys;
      const sample: PerfSample = {
        at: this.now(),
        memUsedPct: sys.ramUsedPct,
        cpuPct: sys.cpuPct,
        swapUsedMb: sys.swapUsedMb,
      };
      if (sys.psiMemAvg10 !== undefined) sample.psiMemAvg10 = sys.psiMemAvg10;
      const ratio = await this.cgroupRatio();
      if (ratio !== undefined) sample.cgroupRatio = ratio;
      this.lastSample = sample;
      this.history.push(sample);
      const cutoff = sample.at - HISTORY_MS;
      while (this.history.length > 1 && this.history[0].at < cutoff) this.history.shift();
      const instant = instantLevel(sample, this.history, sample.at);
      const next = reportedLevel(this.level, this.betterSince, instant, sample.at);
      this.level = next.level;
      this.betterSince = next.betterSince;
    } catch {
      // Leitura falhou (sistema sem /proc, permissão): mantém o último estado conhecido.
    }
  }

  /** Lê RAM, swap, processador e PSI do sistema inteiro. */
  private async readSystem(): Promise<PerfSystem> {
    const cpuCount = os.cpus().length || 1;
    if (this.perfPlatform === 'linux' || this.perfPlatform === 'wsl') {
      const [mem, statTxt, psiMem, psiCpu] = await Promise.all([
        readFile('/proc/meminfo', 'utf8').catch(() => ''),
        readFile('/proc/stat', 'utf8').catch(() => ''),
        readFile('/proc/pressure/memory', 'utf8').catch(() => undefined),
        readFile('/proc/pressure/cpu', 'utf8').catch(() => undefined),
      ]);
      const mi = parseMeminfo(mem);
      const totalMb = Math.round((mi.memTotalKb * 1024) / MB);
      const availMb = Math.round((mi.memAvailableKb * 1024) / MB);
      const usedMb = Math.max(0, totalMb - availMb);
      const cur = parseProcStat(statTxt);
      if (cur) {
        if (this.prevCpu) this.cpuPct = cpuPercentFromDelta(this.prevCpu, cur);
        this.prevCpu = cur;
      }
      const sys: PerfSystem = {
        ramTotalMb: totalMb,
        ramAvailableMb: availMb,
        ramUsedMb: usedMb,
        ramUsedPct: totalMb > 0 ? clampPct((usedMb / totalMb) * 100) : 0,
        swapTotalMb: Math.round((mi.swapTotalKb * 1024) / MB),
        swapUsedMb: Math.round(((mi.swapTotalKb - mi.swapFreeKb) * 1024) / MB),
        cpuPct: this.cpuPct,
        cpuCount,
      };
      const pm = psiMem !== undefined ? parsePressureAvg10(psiMem) : undefined;
      const pc = psiCpu !== undefined ? parsePressureAvg10(psiCpu) : undefined;
      if (pm !== undefined) sys.psiMemAvg10 = pm;
      if (pc !== undefined) sys.psiCpuAvg10 = pc;
      return sys;
    }
    // macOS e outros: os.totalmem/freemem; o processador vem da carga média normalizada pelos núcleos (aproximação).
    const totalMb = Math.round(os.totalmem() / MB);
    const freeMb = Math.round(os.freemem() / MB);
    const usedMb = Math.max(0, totalMb - freeMb);
    const load1 = os.loadavg()[0] ?? 0;
    return {
      ramTotalMb: totalMb,
      ramAvailableMb: freeMb,
      ramUsedMb: usedMb,
      ramUsedPct: totalMb > 0 ? clampPct((usedMb / totalMb) * 100) : 0,
      swapTotalMb: 0,
      swapUsedMb: 0,
      cpuPct: clampPct((load1 / cpuCount) * 100),
      cpuCount,
    };
  }

  /** memory.current / min(memory.high, memory.max) do cgroup do Córtex (undefined se não houver cgroup v2). */
  private async cgroupRatio(): Promise<number | undefined> {
    const cap = await this.cortexCap();
    const limit = minLimit(cap.highMb ?? null, cap.maxMb ?? null);
    if (cap.currentMb === undefined || limit === null || limit <= 0) return undefined;
    return cap.currentMb / limit;
  }

  /** Teto do Córtex no cgroup v2 (current/high/max); vazio quando não se aplica. */
  async cortexCap(): Promise<PerfCortexCap> {
    if (this.perfPlatform !== 'linux' && this.perfPlatform !== 'wsl') return {};
    if (!this.cgroupResolved) {
      this.cgroupResolved = true;
      try {
        const self = parseSelfCgroup(await readFile('/proc/self/cgroup', 'utf8'));
        if (self) this.cgroupPath = `/sys/fs/cgroup${self === '/' ? '' : self}`;
      } catch {
        this.cgroupPath = undefined;
      }
    }
    const dir = this.cgroupPath;
    if (!dir) return {};
    const [curTxt, highTxt, maxTxt] = await Promise.all([
      readFile(`${dir}/memory.current`, 'utf8').catch(() => undefined),
      readFile(`${dir}/memory.high`, 'utf8').catch(() => undefined),
      readFile(`${dir}/memory.max`, 'utf8').catch(() => undefined),
    ]);
    const cap: PerfCortexCap = {};
    if (curTxt !== undefined) {
      const v = parseCgroupValue(curTxt);
      if (v !== null) cap.currentMb = Math.round(v / MB);
    }
    if (highTxt !== undefined) cap.highMb = toMbOrNull(parseCgroupValue(highTxt));
    if (maxTxt !== undefined) cap.maxMb = toMbOrNull(parseCgroupValue(maxTxt));
    return cap;
  }

  /** Mede a árvore de processos de cada sessão (Linux: varre /proc; macOS: `ps -A`). */
  private async readSessions(refs: PerfSessionRef[]): Promise<PerfSessionInfo[]> {
    if (!refs.length) return [];
    if (this.perfPlatform === 'darwin') return this.readSessionsPs(refs);
    return this.readSessionsProc(refs);
  }

  private async readSessionsProc(refs: PerfSessionRef[]): Promise<PerfSessionInfo[]> {
    const pageSize = 4096;
    let names: string[];
    try {
      names = await readdir('/proc');
    } catch {
      return refs.map((r) => this.sessionInfo(r, 0, undefined, 1));
    }
    const byPid = new Map<number, ProcStat>();
    await Promise.all(
      names.map(async (name) => {
        if (!/^\d+$/.test(name)) return;
        const pid = Number(name);
        try {
          const st = parseProcPidStat(await readFile(`/proc/${pid}/stat`, 'utf8'), pid);
          if (st) byPid.set(pid, st);
        } catch {
          // processo saiu entre o readdir e a leitura: ignora
        }
      }),
    );
    const children = childIndex(byPid);
    const now = this.now();
    const out: PerfSessionInfo[] = [];
    const seen = new Set<number>();
    for (const r of refs) {
      const tree = descendants(r.pid, children);
      let rssPages = 0;
      let jiffies = 0;
      let procs = 0;
      for (const pid of tree) {
        const st = byPid.get(pid);
        if (!st) continue;
        rssPages += st.rssPages;
        jiffies += st.jiffies;
        procs++;
      }
      if (!procs) continue; // sessão sem processo vivo: sai da lista
      const memMb = Math.round((rssPages * pageSize) / MB);
      const prev = this.treeCpu.get(r.pid);
      seen.add(r.pid);
      this.treeCpu.set(r.pid, { jiffies, at: now });
      let cpuPct: number | undefined;
      if (prev && now > prev.at) {
        const dSec = (now - prev.at) / 1000;
        cpuPct = clampPct(((jiffies - prev.jiffies) / CLOCK_TICKS / dSec) * 100 / (os.cpus().length || 1));
      }
      out.push(this.sessionInfo(r, memMb, cpuPct, procs));
    }
    for (const pid of [...this.treeCpu.keys()]) if (!seen.has(pid)) this.treeCpu.delete(pid); // esquece sessões que saíram
    return out;
  }

  private async readSessionsPs(refs: PerfSessionRef[]): Promise<PerfSessionInfo[]> {
    const out = await new Promise<string | undefined>((ok) => {
      execFile('ps', ['-A', '-o', 'pid,ppid,rss,%cpu'], { timeout: 10_000 }, (err, stdout) => ok(err ? undefined : String(stdout)));
    });
    if (out === undefined) return refs.map((r) => this.sessionInfo(r, 0, undefined, 1));
    const byPid = parsePsAll(out);
    const children = childIndex(byPid);
    const list: PerfSessionInfo[] = [];
    for (const r of refs) {
      const tree = descendants(r.pid, children);
      let rssKb = 0;
      let cpu = 0;
      let procs = 0;
      for (const pid of tree) {
        const p = byPid.get(pid);
        if (!p) continue;
        rssKb += p.rssKb;
        cpu += p.cpu;
        procs++;
      }
      if (!procs) continue;
      list.push(this.sessionInfo(r, Math.round((rssKb * 1024) / MB), clampPct(cpu), procs));
    }
    return list;
  }

  private sessionInfo(r: PerfSessionRef, memMb: number, cpuPct: number | undefined, procs: number): PerfSessionInfo {
    const info: PerfSessionInfo = { pid: r.pid, name: r.name, project: r.project, account: r.account, memMb, weight: weightOf(memMb), procs };
    if (cpuPct !== undefined) info.cpuPct = Math.round(cpuPct);
    return info;
  }

  /** Monta o PerfSnapshot completo (chamado a cada GET /api/perf). */
  async snapshot(): Promise<PerfSnapshot> {
    const refs = this.getSessions();
    const [sys, cortex, sessions] = await Promise.all([
      this.lastSys ? Promise.resolve(this.lastSys) : this.readSystem(),
      this.cortexCap(),
      this.readSessions(refs),
    ]);
    sessions.sort((a, b) => b.memMb - a.memMb);
    const budget = computeBudget(sys.ramTotalMb * MB, sessions.length);
    const heaviest = sessions[0];
    const snap: PerfSnapshot = {
      platform: this.perfPlatform,
      level: this.level,
      summary: laySummary(this.level, budget.freeSessions),
      system: sys,
      cortex,
      budget,
      sessions,
      sampledAt: this.lastSample?.at ?? this.now(),
    };
    if (heaviest && heaviest.weight !== 'light') snap.heaviestPid = heaviest.pid;
    return snap;
  }

  private lastSys?: PerfSystem;

  get currentLevel(): PerfLevel {
    return this.level;
  }
}

function minLimit(high: number | null, max: number | null): number | null {
  if (high === null) return max;
  if (max === null) return high;
  return Math.min(high, max);
}

function toMbOrNull(v: number | null): number | null {
  return v === null ? null : Math.round(v / MB);
}

// -------------------------------------------------------------------------------------------------------------- rota

type Send = (res: ServerResponse, status: number, body: unknown) => void;

/** Atende GET /api/perf. Mesma exposição das rotas de leitura (/api/snapshot, /api/stats). */
export function createPerfRoutes(monitor: PerfMonitor): (req: IncomingMessage, res: ServerResponse, url: URL, send: Send) => boolean {
  return (req, res, url, send) => {
    if (url.pathname !== '/api/perf') return false;
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET');
      send(res, 405, { error: tr('método não permitido') });
      return true;
    }
    req.resume();
    monitor
      .snapshot()
      .then((snap) => send(res, 200, snap))
      .catch(() => send(res, 500, { error: tr('não deu para ler o desempenho agora') }));
    return true;
  };
}
