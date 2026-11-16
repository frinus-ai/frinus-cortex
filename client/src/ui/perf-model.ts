// Modelo puro do painel "Desempenho": rótulos leigos, estados dos medidores e formatação. Sem DOM nem rede, para
// testar em perf-model.test.ts. A interface (pílula + janela) está em ui/perf.ts.
import type { PerfLevel, PerfSessionInfo, PerfSnapshot, PerfWeight } from '../../../shared/types';
import { tr } from '../../../shared/i18n';

/** Texto curto da pílula do semáforo (sempre visível na barra do topo). */
export function levelLabel(level: PerfLevel): string {
  if (level === 'red') return tr('Cheio');
  if (level === 'yellow') return tr('Enchendo');
  return tr('Tranquilo');
}

/** Descrição do semáforo para leitor de tela. */
export function levelAria(level: PerfLevel): string {
  if (level === 'red') return tr('Desempenho: máquina sobrecarregada');
  if (level === 'yellow') return tr('Desempenho: máquina começando a encher');
  return tr('Desempenho: máquina tranquila');
}

/** Rótulo do peso de uma sessão. */
export function weightLabel(weight: PerfWeight): string {
  if (weight === 'heavy') return tr('pesado');
  if (weight === 'medium') return tr('médio');
  return tr('leve');
}

/** Estado de cor de um medidor: ok (verde) · warn (amarelo) · bad (vermelho). */
export type MeterState = 'ok' | 'warn' | 'bad';

/** Medidor de memória pela % em uso (mesmos cortes do semáforo: 70 / 85). */
export function memMeter(pct: number): MeterState {
  if (pct > 85) return 'bad';
  if (pct >= 70) return 'warn';
  return 'ok';
}

/** Medidor de processador pela % em uso (cortes 75 / 90). */
export function cpuMeter(pct: number): MeterState {
  if (pct > 90) return 'bad';
  if (pct >= 75) return 'warn';
  return 'ok';
}

/** Medidor de folga: sem folga (bad), uma só (warn), duas ou mais (ok). */
export function freeMeter(free: number): MeterState {
  if (free <= 0) return 'bad';
  if (free === 1) return 'warn';
  return 'ok';
}

/** Valor de 0 a 100 para a largura de uma barra. */
export function barPct(value: number, max: number): number {
  if (!(max > 0)) return 0;
  const p = (value / max) * 100;
  return p < 0 ? 0 : p > 100 ? 100 : Math.round(p);
}

/** MB em texto leigo: "1,2 GB" acima de 1024 MB, senão "430 MB". Vírgula decimal (pt-BR). */
export function formatMb(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024;
    const s = (Math.round(gb * 10) / 10).toFixed(1).replace('.', ',');
    return tr('{0} GB', [s]);
  }
  return tr('{0} MB', [Math.round(mb)]);
}

/** Texto da folga de trabalhos (quantos cabem ainda). */
export function freeText(free: number): string {
  if (free <= 0) return tr('sem folga');
  if (free === 1) return tr('cabe mais 1');
  return tr('cabem mais {0}', [free]);
}

/** A sessão mais pesada do snapshot (pelo heaviestPid que o servidor marcou), ou undefined. */
export function heaviestSession(snap: PerfSnapshot): PerfSessionInfo | undefined {
  if (snap.heaviestPid === undefined) return undefined;
  return snap.sessions.find((s) => s.pid === snap.heaviestPid);
}

/** Texto "RAM: 8,0 GB de 30,0 GB (26%)" para os detalhes. */
export function ramDetail(snap: PerfSnapshot): string {
  const sys = snap.system;
  return tr('Memória: {0} de {1} em uso ({2}%)', [formatMb(sys.ramUsedMb), formatMb(sys.ramTotalMb), Math.round(sys.ramUsedPct)]);
}
