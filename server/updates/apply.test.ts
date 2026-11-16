// Testes do "Atualizar Córtex": o plano (comando destacado) e a trava do dry-run (nunca executa).
import { describe, expect, it, vi } from 'vitest';
import { defaultUpdateScript, UpdateApplier } from './apply';

const base = {
  rootDir: '/home/user/frinus-office',
  service: 'frinus-office',
  platform: 'linux' as const,
  hasSystemd: true,
  now: () => 1700,
};

describe('defaultUpdateScript', () => {
  it('baixa a versão nova (update-cortex.sh) — o install-cortex.sh reinicia o serviço', () => {
    const s = defaultUpdateScript('/root', 'frinus-cortex');
    expect(s).toContain("bash '/root/frinus/bin/update-cortex.sh' --service 'frinus-cortex'");
    // NÃO roda o install-office.sh local (recompilaria a versão em uso), nem um systemctl restart solto
    // (o install-cortex.sh, chamado pelo update-cortex.sh, é quem reinicia o serviço).
    expect(s).not.toContain('install-office.sh');
    expect(s).not.toContain('systemctl');
  });
  it('respeita um comando custom', () => {
    expect(defaultUpdateScript('/root', 'svc', 'echo oi')).toBe('echo oi');
  });
});

describe('buildPlan', () => {
  it('Linux com systemd: comando destacado via systemd-run', () => {
    const plan = new UpdateApplier({ ...base, dryRun: true }).buildPlan();
    expect(plan.command?.file).toBe('systemd-run');
    expect(plan.command?.args).toContain('--user');
    expect(plan.command?.args.join(' ')).toContain('--unit=frinus-cortex-update-1700');
    expect(plan.restarts).toBe(true);
    expect(plan.service).toBe('frinus-office');
  });

  it('macOS com launchd: usa launchctl kickstart', () => {
    const plan = new UpdateApplier({ ...base, platform: 'darwin', hasSystemd: false, launchdLabel: 'com.frinus.cortex', dryRun: true }).buildPlan();
    expect(plan.command?.file).toBe('/bin/sh');
    expect(plan.command?.args.join(' ')).toContain('launchctl kickstart -k gui/');
    expect(plan.restarts).toBe(true);
  });

  it('sem systemd nem serviço: plano manual, sem comando', () => {
    const plan = new UpdateApplier({ ...base, hasSystemd: false, service: undefined, dryRun: true }).buildPlan();
    expect(plan.command).toBeUndefined();
    expect(plan.manual).toContain('update-cortex.sh');
    expect(plan.restarts).toBe(false);
  });
});

describe('apply — trava do dry-run', () => {
  it('dryRun: NUNCA chama o executor', () => {
    const spawnDetached = vi.fn();
    const r = new UpdateApplier({ ...base, dryRun: true, spawnDetached }).apply();
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(r.started).toBe(false);
    expect(r.plan.dryRun).toBe(true);
    expect(r.plan.command).toBeDefined(); // o plano existe, só não roda
  });

  it('fora do dryRun: dispara o comando destacado uma vez', () => {
    const spawnDetached = vi.fn();
    const r = new UpdateApplier({ ...base, dryRun: false, spawnDetached }).apply();
    expect(spawnDetached).toHaveBeenCalledTimes(1);
    expect(spawnDetached).toHaveBeenCalledWith('systemd-run', expect.arrayContaining(['--user']));
    expect(r.started).toBe(true);
  });

  it('plano manual nunca inicia nada, mesmo fora do dryRun', () => {
    const spawnDetached = vi.fn();
    const r = new UpdateApplier({ ...base, hasSystemd: false, service: undefined, dryRun: false, spawnDetached }).apply();
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(r.started).toBe(false);
  });
});
