// Instala (ou confere) o guarda de delegação do Frinus em cada conta do Claude Code. Roda no HOST, com tsx:
//
//   npm run delegation:install          # escreve o hook + registra em settings.json + corrige agents/frinus.md
//   npm run delegation:status           # mostra, por conta, o que falta (não grava nada)
//   (opções: --dry-run, --node <caminho>)
//
// A lógica vive em server/accounts/delegation.ts (a MESMA que o servidor roda no boot, via heal). Este CLI é
// só a casca: descobre as contas (FRINUS_ONLY=1 limita às contas com o MCP do Frinus), chama e imprime.
//
// Idempotente: pode rodar de novo com segurança. Antes de gravar o settings.json, uma cópia vai para
// settings.json.frinus-backup-<data> (os hooks de terceiros — CARL, statusline... — são preservados).
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installDelegationGuards, type AccountResult, type InstallOptions } from '../server/accounts/delegation';
import { tr } from '../shared/i18n';

const USAGE = tr(`Uso: npm run delegation:<install|status> [-- opções]

  install   escreve o hook e registra os hooks em settings.json; corrige agents/frinus.md (faz backup)
  status    mostra o que falta por conta, sem gravar nada

Opções:
  --dry-run        mostra o que mudaria, sem gravar nada
  --node <cmd>     comando do node usado no hook (padrão: o node em execução)
  -h, --help       esta ajuda

Contas: as mesmas do servidor (~/.claude* com agents/frinus.md; FRINUS_ONLY=1 limita às contas do Frinus).`);

export interface RunOptions {
  command: 'install' | 'status';
  dryRun: boolean;
  nodeCmd?: string;
}

export function parseArgs(argv: string[]): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let dryRun = false;
  let nodeCmd: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--node') {
      nodeCmd = argv[++i];
      if (!nodeCmd) throw new Error(tr('--node precisa de um caminho.'));
    } else if ((a === 'install' || a === 'status') && !command) command = a;
    else throw new Error(tr('opção desconhecida: {0}\n\n{1}', [a, USAGE]));
  }
  if (!command) throw new Error(tr('diga o que fazer: install ou status.\n\n{0}', [USAGE]));
  return { command, dryRun, nodeCmd };
}

/** Descreve o resultado de uma conta em uma linha. */
export function describe(r: AccountResult, home: string): string {
  const label = basename(r.dir) || r.dir;
  if (r.skipped) return tr('• {0}: pulada ({1})', [label, r.skipped]);
  if (r.error) return `✗ ${label}: ${r.error}`;
  const bits: string[] = [];
  if (r.scriptWritten) bits.push(tr('hook'));
  if (r.settingsChanged) bits.push(tr('settings.json'));
  if (r.frinusMdChanged) bits.push('frinus.md');
  if (r.specialistChanged) bits.push('frinus-specialist.md');
  const backup = r.backup ? tr(' · backup em {0}', [tildify(r.backup, home)]) : '';
  if (!bits.length) return tr('= {0}: já em dia', [label]);
  return `✓ ${label}: ${bits.join(', ')}${backup}`;
}

function tildify(p: string, home: string): string {
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

export function run(opts: RunOptions, home: string, out: (line: string) => void): number {
  const installOpts: InstallOptions = { nodeCmd: opts.nodeCmd, dryRun: opts.dryRun || opts.command === 'status' };
  const results = installDelegationGuards(home, installOpts);
  const real = results.filter((r) => !r.skipped);
  if (!real.length) {
    out(tr('Nenhuma conta com agents/frinus.md encontrada (instale a equipe do Frinus primeiro).'));
    // ainda lista as puladas, para não confundir
    for (const r of results) out(describe(r, home));
    return results.length ? 0 : 1;
  }
  for (const r of results) out(describe(r, home));
  return results.some((r) => r.error) ? 1 : 0;
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  const home = process.env.HOME || homedir();
  process.exitCode = run(parsed, home, (l) => console.log(l));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (err) {
    console.error(tr('[delegation] Erro: {0}', [(err as Error).message]));
    process.exitCode = 1;
  }
}
