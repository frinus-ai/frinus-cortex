// "Atualizar Córtex": baixa a versão nova e reinicia o serviço. O reinício ENCERRA todas as sessões abertas, então
// quem chama (a interface) só dispara depois de uma confirmação que lista os trabalhos que serão fechados.
//
// O passo mais delicado é reiniciar sem matar a própria atualização no meio: o comando roda DESTACADO do processo do
// Córtex (systemd-run --user no Linux/WSL; launchctl kickstart no macOS; caso contrário, devolve o comando para a
// pessoa rodar à mão). Assim o updater roda o instalador e só então reinicia o serviço — o processo atual morre, mas o
// updater sobrevive e sobe a versão nova, e a página recarrega sozinha quando o servidor volta.
//
// SEGURANÇA: com `dryRun` ligado (FRINUS_CORTEX_UPDATE_DRYRUN=1) nada é instalado nem reiniciado — só devolve o plano
// do que FARIA. O executor real é injetado (`spawnDetached`), então os testes rodam sem tocar no sistema.
import { spawn } from 'node:child_process';
import { tr } from '../../shared/i18n';

export type UpdatePlatform = 'linux' | 'wsl' | 'darwin' | 'other';

export interface UpdatePlan {
  /** Passos em linguagem simples (PT) para mostrar na interface. */
  steps: string[];
  /** Comando destacado que seria executado (programa + argumentos). undefined quando não dá para automatizar. */
  command?: { file: string; args: string[] };
  /** Mensagem quando não há como reiniciar sozinho (ex.: macOS sem launchd, ou sem systemd). */
  manual?: string;
  /** Nome do serviço que seria reiniciado. */
  service?: string;
  dryRun: boolean;
  /** O reinício derruba as sessões abertas (sempre true quando há comando). */
  restarts: boolean;
}

export interface UpdateApplierOptions {
  /** Raiz do fork (onde está frinus/bin/update-cortex.sh). */
  rootDir: string;
  /** Nome do serviço systemd --user (FRINUS_CORTEX_SERVICE; padrão frinus-cortex); sem ele, só o plano manual. */
  service?: string;
  platform: UpdatePlatform;
  /** Há systemd --user disponível? (Linux/WSL). */
  hasSystemd: boolean;
  /** Rótulo do agente launchd (macOS), quando existe. */
  launchdLabel?: string;
  dryRun: boolean;
  /**
   * Comando de atualização que substitui o padrão (FRINUS_CORTEX_UPDATE_CMD): um script de shell rodado destacado,
   * antes do reinício. Útil quando a instalação real atualiza o código de outro jeito.
   */
  updateCmd?: string;
  /** Executor real do comando destacado (injeta nos testes). Padrão: spawn com detached+unref. */
  spawnDetached?: (file: string, args: string[]) => void;
  now?: () => number;
}

/** Script de shell padrão: roda o instalador do Córtex e reinicia o serviço. */
export function defaultUpdateScript(rootDir: string, service: string, custom?: string): string {
  if (custom && custom.trim()) return custom;
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  // update-cortex.sh BAIXA a versão pronta da release (confere o SHA-256 e faz a troca atômica em
  // ~/.local/share/frinus-cortex) e então roda o install-cortex.sh, que reinstala e REINICIA o serviço.
  // Não é o install-office.sh local: aquele só recompilaria a versão EM USO, sem baixar a nova.
  return [
    'set -e',
    `bash ${q(`${rootDir}/frinus/bin/update-cortex.sh`)} --service ${q(service)}`,
  ].join('\n');
}

export class UpdateApplier {
  private readonly o: UpdateApplierOptions;
  private readonly spawnDetached: (file: string, args: string[]) => void;

  constructor(opts: UpdateApplierOptions) {
    this.o = opts;
    this.spawnDetached =
      opts.spawnDetached ??
      ((file, args) => {
        const child = spawn(file, args, { detached: true, stdio: 'ignore' });
        child.unref();
      });
  }

  /** Monta o plano (puro: não executa nada). */
  buildPlan(): UpdatePlan {
    const { rootDir, service, platform, hasSystemd, launchdLabel, dryRun, updateCmd } = this.o;
    if ((platform === 'linux' || platform === 'wsl') && hasSystemd && service) {
      const script = defaultUpdateScript(rootDir, service, updateCmd);
      // systemd-run --user roda o script num escopo próprio, fora do processo do Córtex: ele sobrevive ao reinício.
      const unit = `frinus-cortex-update-${(this.o.now ?? Date.now)()}`;
      return {
        steps: [
          tr('Baixar e instalar a versão nova do Frinus Córtex (roda o instalador).'),
          tr('Reiniciar o serviço “{0}” — isso fecha os trabalhos abertos.', [service]),
          tr('A página recarrega sozinha quando o Córtex voltar.'),
        ],
        command: { file: 'systemd-run', args: ['--user', '--collect', `--unit=${unit}`, '/bin/sh', '-c', script] },
        service,
        dryRun,
        restarts: true,
      };
    }
    if (platform === 'darwin' && launchdLabel) {
      const script = updateCmd?.trim() || `cd '${rootDir}' && bash '${rootDir}/frinus/bin/update-cortex.sh'`;
      return {
        steps: [
          tr('Baixar e instalar a versão nova do Frinus Córtex.'),
          tr('Reiniciar o serviço “{0}” — isso fecha os trabalhos abertos.', [launchdLabel]),
          tr('A página recarrega sozinha quando o Córtex voltar.'),
        ],
        command: { file: '/bin/sh', args: ['-c', `${script} && launchctl kickstart -k gui/$(id -u)/${launchdLabel}`] },
        service: launchdLabel,
        dryRun,
        restarts: true,
      };
    }
    // Sem como automatizar: devolve o comando para a pessoa rodar à mão.
    const manualCmd = `bash '${rootDir}/frinus/bin/update-cortex.sh'${service ? ` --service '${service}'` : ''}`;
    return {
      steps: [tr('Este Córtex não dá para atualizar sozinho por aqui.')],
      manual: tr('Rode no terminal: {0}', [manualCmd]),
      dryRun,
      restarts: false,
    };
  }

  /**
   * Aplica: no dryRun só devolve o plano; senão dispara o comando destacado. `started` indica se o updater foi lançado
   * de verdade (sempre false no dryRun e quando não há comando automatizável).
   */
  apply(): { started: boolean; plan: UpdatePlan } {
    const plan = this.buildPlan();
    if (this.o.dryRun || !plan.command) return { started: false, plan };
    this.spawnDetached(plan.command.file, plan.command.args);
    return { started: true, plan };
  }
}
