// Testes das funções puras do painel "Desempenho": orçamento, semáforo (com histerese) e os parsers de /proc.
import { describe, expect, it } from 'vitest';
import {
  childIndex,
  computeBudget,
  cpuPercentFromDelta,
  descendants,
  detectPlatform,
  instantLevel,
  laySummary,
  parseCgroupValue,
  parseMeminfo,
  parsePressureAvg10,
  parseProcPidStat,
  parseProcStat,
  parsePsAll,
  parseSelfCgroup,
  psiSustainedRed,
  reportedLevel,
  reserveBytes,
  swapGrowing,
  weightOf,
  type PerfSample,
} from './perf';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

describe('orçamento', () => {
  it('reserva é o maior entre 2 GB e 25% da RAM', () => {
    expect(reserveBytes(4 * GB)).toBe(2 * GB); // 25% = 1 GB < 2 GB
    expect(reserveBytes(16 * GB)).toBe(4 * GB); // 25% = 4 GB > 2 GB
  });

  it('calcula sessões_max = floor((orçamento − 200 MB) / 1,2 GB)', () => {
    // 30 GB: reserva 7,5 GB; orçamento 22,5 GB; (22,5 GB − 200 MB)/1,2 GB ≈ 18
    const b = computeBudget(30 * GB, 3);
    expect(b.reserveMb).toBe(Math.round(7.5 * GB / MB));
    expect(b.sessionsMax).toBe(18);
    expect(b.sessionsActive).toBe(3);
    expect(b.freeSessions).toBe(15);
  });

  it('sessões_max nunca é menor que 1, mesmo em máquina pequena', () => {
    expect(computeBudget(2 * GB, 0).sessionsMax).toBe(1);
    expect(computeBudget(1 * GB, 5).sessionsMax).toBe(1);
  });

  it('folga pode ser negativa quando passou do orçamento', () => {
    expect(computeBudget(8 * GB, 10).freeSessions).toBeLessThan(0);
  });
});

describe('peso leigo', () => {
  it('leve < 600 MB, médio < 1200 MB, pesado acima', () => {
    expect(weightOf(430)).toBe('light');
    expect(weightOf(599)).toBe('light');
    expect(weightOf(600)).toBe('medium');
    expect(weightOf(1199)).toBe('medium');
    expect(weightOf(1800)).toBe('heavy');
  });
});

describe('semáforo — nível instantâneo', () => {
  const base = { memUsedPct: 40, cpuPct: 20, swapUsedMb: 0 };

  it('verde quando memória < 70%, cpu < 75% e PSI ≤ 10', () => {
    expect(instantLevel(base, [], 0)).toBe('green');
  });

  it('amarelo por memória entre 70 e 85%', () => {
    expect(instantLevel({ ...base, memUsedPct: 78 }, [], 0)).toBe('yellow');
  });

  it('amarelo por processador entre 75 e 90%', () => {
    expect(instantLevel({ ...base, cpuPct: 82 }, [], 0)).toBe('yellow');
  });

  it('amarelo por PSI de memória > 10', () => {
    expect(instantLevel({ ...base, psiMemAvg10: 12 }, [], 0)).toBe('yellow');
  });

  it('vermelho por memória > 85%', () => {
    expect(instantLevel({ ...base, memUsedPct: 88 }, [], 0)).toBe('red');
  });

  it('vermelho quando o cgroup do Córtex chega a 90% do limite', () => {
    expect(instantLevel({ ...base, cgroupRatio: 0.92 }, [], 0)).toBe('red');
    expect(instantLevel({ ...base, cgroupRatio: 0.8 }, [], 0)).toBe('green'); // abaixo de 0,9 o cgroup não muda o nível
  });
});

describe('semáforo — swap crescendo e PSI sustentado', () => {
  it('detecta swap em crescimento (>32 MB em ~10 s, acima de 64 MB)', () => {
    const now = 100_000;
    const hist: PerfSample[] = [
      { at: now - 12_000, memUsedPct: 60, cpuPct: 10, swapUsedMb: 100 },
      { at: now, memUsedPct: 60, cpuPct: 10, swapUsedMb: 200 },
    ];
    expect(swapGrowing(hist, now)).toBe(true);
    expect(instantLevel(hist[1], hist, now)).toBe('red');
  });

  it('ignora swap irrisório (≤ 64 MB)', () => {
    const now = 100_000;
    const hist: PerfSample[] = [
      { at: now - 12_000, memUsedPct: 60, cpuPct: 10, swapUsedMb: 5 },
      { at: now, memUsedPct: 60, cpuPct: 10, swapUsedMb: 50 },
    ];
    expect(swapGrowing(hist, now)).toBe(false);
  });

  it('PSI sustentado > 20 por ≥ 15 s vira vermelho; um pico isolado não', () => {
    const now = 100_000;
    const sustained: PerfSample[] = [];
    for (let t = now - 16_000; t <= now; t += 2500) sustained.push({ at: t, memUsedPct: 60, cpuPct: 10, swapUsedMb: 0, psiMemAvg10: 25 });
    expect(psiSustainedRed(sustained, now)).toBe(true);

    const spike: PerfSample[] = [
      { at: now - 2500, memUsedPct: 60, cpuPct: 10, swapUsedMb: 0, psiMemAvg10: 5 },
      { at: now, memUsedPct: 60, cpuPct: 10, swapUsedMb: 0, psiMemAvg10: 25 },
    ];
    expect(psiSustainedRed(spike, now)).toBe(false);
  });
});

describe('semáforo — histerese', () => {
  it('piora na hora', () => {
    const r = reportedLevel('green', null, 'red', 1000);
    expect(r.level).toBe('red');
  });

  it('só melhora depois de a condição melhor se manter ~10 s', () => {
    // Instantâneo caiu para verde, mas o relatado continua amarelo até 10 s depois.
    let state = reportedLevel('yellow', null, 'green', 0);
    expect(state.level).toBe('yellow');
    expect(state.betterSince).toBe(0);
    state = reportedLevel(state.level, state.betterSince, 'green', 5000);
    expect(state.level).toBe('yellow'); // ainda não deu 10 s
    state = reportedLevel(state.level, state.betterSince, 'green', 10_000);
    expect(state.level).toBe('green'); // 10 s cumpridos
  });

  it('se piorar de novo no meio da recuperação, zera o relógio', () => {
    let state = reportedLevel('red', null, 'yellow', 0);
    expect(state.level).toBe('red');
    state = reportedLevel(state.level, state.betterSince, 'red', 4000); // voltou a vermelho
    expect(state.level).toBe('red');
    expect(state.betterSince).toBe(null);
  });
});

describe('frase leiga', () => {
  it('verde cita quantos trabalhos cabem', () => {
    expect(laySummary('green', 3)).toContain('3');
    expect(laySummary('green', 1)).toContain('1');
    expect(laySummary('green', 0)).toContain('limite');
  });
  it('vermelho sugere pausar/fechar', () => {
    expect(laySummary('red', -2).toLowerCase()).toContain('sobrecarregada');
  });
});

describe('parsers /proc', () => {
  it('parseMeminfo lê total, disponível e swap', () => {
    const txt = ['MemTotal:       30000000 kB', 'MemFree:         1000000 kB', 'MemAvailable:   20000000 kB', 'SwapTotal:       4000000 kB', 'SwapFree:        3500000 kB'].join('\n');
    const m = parseMeminfo(txt);
    expect(m.memTotalKb).toBe(30000000);
    expect(m.memAvailableKb).toBe(20000000);
    expect(m.swapTotalKb).toBe(4000000);
    expect(m.swapFreeKb).toBe(3500000);
  });

  it('parsePressureAvg10 pega "some avg10"', () => {
    const txt = 'some avg10=12.34 avg60=5.00 avg300=1.00 total=123\nfull avg10=2.00 avg60=1.00 avg300=0.50 total=10';
    expect(parsePressureAvg10(txt)).toBeCloseTo(12.34);
    expect(parsePressureAvg10('garbage')).toBeUndefined();
  });

  it('parseProcStat soma jiffies e idle', () => {
    const s = parseProcStat('cpu  100 0 50 800 40 0 10 0 0 0\ncpu0 ...');
    expect(s).toEqual({ total: 100 + 0 + 50 + 800 + 40 + 10, idle: 800 + 40 });
  });

  it('cpuPercentFromDelta calcula ocupação entre duas leituras', () => {
    const prev = { total: 1000, idle: 800 };
    const cur = { total: 1100, idle: 850 }; // +100 total, +50 idle -> 50% ocupado
    expect(cpuPercentFromDelta(prev, cur)).toBeCloseTo(50);
    expect(cpuPercentFromDelta(cur, cur)).toBe(0);
  });

  it('parseCgroupValue trata "max" como sem limite', () => {
    expect(parseCgroupValue('max')).toBeNull();
    expect(parseCgroupValue('2147483648')).toBe(2147483648);
    expect(parseCgroupValue('')).toBeNull();
  });

  it('parseSelfCgroup extrai o caminho v2', () => {
    expect(parseSelfCgroup('0::/user.slice/frinus.scope')).toBe('/user.slice/frinus.scope');
    expect(parseSelfCgroup('12:pids:/legacy')).toBeUndefined();
  });

  it('parseProcPidStat lida com comm entre parênteses e com espaços', () => {
    // pid comm state ppid ... utime(14) stime(15) ... rss(24). Campos após ')': ppid=rest[1], utime=rest[11], stime=rest[12], rss=rest[21].
    const fields = ['R', '4242', '0', '0', '0', '0', '0', '0', '0', '0', '0', '120', '30', '0', '0', '0', '0', '0', '0', '0', '0', '5000'];
    const txt = `1234 (claude code (node)) ${fields.join(' ')}`;
    const st = parseProcPidStat(txt, 1234);
    expect(st).toEqual({ pid: 1234, ppid: 4242, jiffies: 150, rssPages: 5000 });
  });

  it('parsePsAll lê a saída do ps do macOS (pula cabeçalho)', () => {
    const txt = '  PID  PPID    RSS %CPU\n  100     1 400000  2.5\n  200   100 100000  1.0';
    const m = parsePsAll(txt);
    expect(m.get(100)).toEqual({ ppid: 1, rssKb: 400000, cpu: 2.5 });
    expect(m.get(200)).toEqual({ ppid: 100, rssKb: 100000, cpu: 1.0 });
  });
});

describe('árvore de processos', () => {
  it('descendants junta o raiz e todos os filhos', () => {
    const byPid = new Map([
      [100, { ppid: 1 }],
      [200, { ppid: 100 }],
      [300, { ppid: 200 }],
      [400, { ppid: 1 }],
    ]);
    const children = childIndex(byPid);
    expect(descendants(100, children).sort()).toEqual([100, 200, 300]);
    expect(descendants(400, children)).toEqual([400]);
  });
});

describe('plataforma', () => {
  it('detecta wsl por WSL_DISTRO_NAME ou "microsoft" em /proc/version', () => {
    expect(detectPlatform('linux', 'Linux version 5.15 microsoft-standard', {})).toBe('wsl');
    expect(detectPlatform('linux', 'Linux version 6.14', { WSL_DISTRO_NAME: 'Ubuntu' })).toBe('wsl');
    expect(detectPlatform('linux', 'Linux version 6.14 generic', {})).toBe('linux');
    expect(detectPlatform('darwin', undefined, {})).toBe('darwin');
    expect(detectPlatform('win32', undefined, {})).toBe('other');
  });
});
