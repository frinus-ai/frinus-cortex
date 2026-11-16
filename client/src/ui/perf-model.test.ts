// Testes do modelo puro do painel "Desempenho".
import { describe, expect, it } from 'vitest';
import type { PerfSnapshot } from '../../../shared/types';
import { barPct, cpuMeter, formatMb, freeMeter, freeText, heaviestSession, levelLabel, memMeter, weightLabel } from './perf-model';

describe('rótulos', () => {
  it('pílula por nível', () => {
    expect(levelLabel('green')).toBe('Tranquilo');
    expect(levelLabel('yellow')).toBe('Enchendo');
    expect(levelLabel('red')).toBe('Cheio');
  });
  it('peso', () => {
    expect(weightLabel('light')).toBe('leve');
    expect(weightLabel('medium')).toBe('médio');
    expect(weightLabel('heavy')).toBe('pesado');
  });
});

describe('medidores', () => {
  it('memória usa 70 / 85', () => {
    expect(memMeter(40)).toBe('ok');
    expect(memMeter(72)).toBe('warn');
    expect(memMeter(90)).toBe('bad');
  });
  it('processador usa 75 / 90', () => {
    expect(cpuMeter(50)).toBe('ok');
    expect(cpuMeter(80)).toBe('warn');
    expect(cpuMeter(95)).toBe('bad');
  });
  it('folga: 0 ruim, 1 atenção, 2+ ok', () => {
    expect(freeMeter(0)).toBe('bad');
    expect(freeMeter(-1)).toBe('bad');
    expect(freeMeter(1)).toBe('warn');
    expect(freeMeter(4)).toBe('ok');
  });
});

describe('formatação', () => {
  it('barPct recorta entre 0 e 100', () => {
    expect(barPct(50, 100)).toBe(50);
    expect(barPct(150, 100)).toBe(100);
    expect(barPct(-5, 100)).toBe(0);
    expect(barPct(5, 0)).toBe(0);
  });
  it('formatMb mostra GB com vírgula acima de 1024 MB', () => {
    expect(formatMb(430)).toBe('430 MB');
    expect(formatMb(1536)).toBe('1,5 GB');
    expect(formatMb(1024)).toBe('1,0 GB');
  });
  it('freeText', () => {
    expect(freeText(0)).toBe('sem folga');
    expect(freeText(1)).toBe('cabe mais 1');
    expect(freeText(3)).toBe('cabem mais 3');
  });
});

describe('mais pesada', () => {
  const snap = (): PerfSnapshot => ({
    platform: 'linux',
    level: 'yellow',
    summary: '',
    system: { ramTotalMb: 30000, ramAvailableMb: 20000, ramUsedMb: 10000, ramUsedPct: 33, swapTotalMb: 0, swapUsedMb: 0, cpuPct: 20, cpuCount: 8 },
    cortex: {},
    budget: { reserveMb: 7680, budgetMb: 22320, sessionsMax: 18, sessionsActive: 2, freeSessions: 16 },
    sessions: [
      { pid: 100, name: 'Marina', project: 'app', account: '.claude', memMb: 1800, weight: 'heavy', procs: 5 },
      { pid: 200, name: 'João', project: 'api', account: '.claude', memMb: 500, weight: 'light', procs: 3 },
    ],
    heaviestPid: 100,
    sampledAt: 0,
  });

  it('acha a sessão pelo heaviestPid', () => {
    expect(heaviestSession(snap())?.name).toBe('Marina');
  });
  it('undefined quando não há destaque', () => {
    const s = snap();
    delete s.heaviestPid;
    expect(heaviestSession(s)).toBeUndefined();
  });
});
