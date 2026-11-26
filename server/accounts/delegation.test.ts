import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test/fixtures';
import {
  BLOCK_END,
  BLOCK_START,
  DELEGATION_BLOCK,
  DENY_REASON,
  HOOK_SCRIPT_NAME,
  HOOK_SCRIPT_SOURCE,
  installDelegationGuards,
  isOurHook,
  mergeDelegationHooks,
  patchFrinusMd,
  patchSpecialistMd,
  type Settings,
} from './delegation';

const FRINUS_MD = `---
name: frinus
description: "orquestração"
agentId: 7901b410-8832-486f-bf00-b68f64877173
is_orchestrator: true
---

> REGRA ZERO — MCP é obrigatório.

## Regra de Boot (fonte única)
Você é o agente \`7901b410-8832-486f-bf00-b68f64877173\`.
\`\`\`
agent_bootstrap(agent_id="7901b410-8832-486f-bf00-b68f64877173")
\`\`\`

## Delegação real (sem impersonate)
1. agent_list() → roster.
`;

const SPECIALIST_MD = `---
name: frinus-specialist
description: "Subagent camaleão Frinus. NÃO use general-purpose quando há especialista de domínio."
model: inherit
---

## Boot dinâmico
Você é um agente camaleão.
`;

describe('patchFrinusMd', () => {
  it('insere o bloco depois da Regra de Boot, entre marcadores, sem tocar no frontmatter', () => {
    const out = patchFrinusMd(FRINUS_MD);
    expect(out).toContain(BLOCK_START);
    expect(out).toContain(BLOCK_END);
    expect(out).toContain(DELEGATION_BLOCK);
    // frontmatter intacto
    expect(out).toContain('agentId: 7901b410-8832-486f-bf00-b68f64877173');
    // o bloco fica ANTES de "## Delegação real" e DEPOIS da Regra de Boot
    expect(out.indexOf('## Regra de Boot')).toBeLessThan(out.indexOf(BLOCK_START));
    expect(out.indexOf(BLOCK_START)).toBeLessThan(out.indexOf('## Delegação real'));
  });

  it('é idempotente (rodar de novo não muda nada)', () => {
    const once = patchFrinusMd(FRINUS_MD);
    const twice = patchFrinusMd(once);
    expect(twice).toBe(once);
  });

  it('substitui o conteúdo antigo entre marcadores (atualização do bloco)', () => {
    const stale = patchFrinusMd(FRINUS_MD).replace(DELEGATION_BLOCK, '## Bloco velho\\n- regra antiga');
    const fixed = patchFrinusMd(stale);
    expect(fixed).toContain(DELEGATION_BLOCK);
    expect(fixed).not.toContain('Bloco velho');
    // um único par de marcadores
    expect(fixed.match(new RegExp(BLOCK_START, 'g'))?.length).toBe(1);
  });

  it('cai no fim quando não há seção Regra de Boot', () => {
    const out = patchFrinusMd('# Título\n\nsem boot aqui.\n');
    expect(out).toContain(BLOCK_START);
    expect(out).toContain(DELEGATION_BLOCK);
  });
});

describe('patchSpecialistMd', () => {
  it('não muda um arquivo já correto (description em 1 linha + menciona general-purpose)', () => {
    expect(patchSpecialistMd(SPECIALIST_MD)).toBe(SPECIALIST_MD);
  });

  it('acrescenta a nota quando o arquivo não menciona general-purpose', () => {
    const md = SPECIALIST_MD.replace('. NÃO use general-purpose quando há especialista de domínio.', '.');
    const out = patchSpecialistMd(md);
    expect(out).toMatch(/general-purpose/i);
    // idempotente
    expect(patchSpecialistMd(out)).toBe(out);
  });

  it('junta uma description quebrada em várias linhas numa só', () => {
    const md = `---
name: frinus-specialist
description: "linha um
linha dois general-purpose"
model: inherit
---

corpo.
`;
    const out = patchSpecialistMd(md);
    const descLine = out.split('\n').find((l) => l.startsWith('description:'));
    expect(descLine).toBe('description: "linha um linha dois general-purpose"');
  });
});

describe('mergeDelegationHooks', () => {
  const CMD = 'node "/home/u/.claude/frinus-hooks/delegation-guard.mjs"';

  it('registra PreToolUse(Agent|Task) e SessionStart(compact)', () => {
    const { settings, changed } = mergeDelegationHooks({}, CMD);
    expect(changed).toBe(true);
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual([{ matcher: 'Agent|Task', hooks: [{ type: 'command', command: CMD }] }]);
    expect(hooks.SessionStart).toEqual([{ matcher: 'compact', hooks: [{ type: 'command', command: CMD }] }]);
  });

  it('preserva hooks de terceiros (CARL, statusline)', () => {
    const base: Settings = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'carl-guard.sh' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'carl-stop.sh' }] }],
      },
    };
    const { settings } = mergeDelegationHooks(base, CMD);
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toContainEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: 'carl-guard.sh' }] });
    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'carl-stop.sh' }] }]);
    expect(hooks.PreToolUse).toContainEqual({ matcher: 'Agent|Task', hooks: [{ type: 'command', command: CMD }] });
  });

  it('é idempotente (segunda passada não muda nada)', () => {
    const first = mergeDelegationHooks({}, CMD);
    const second = mergeDelegationHooks(first.settings, CMD);
    expect(second.changed).toBe(false);
    expect(second.settings).toEqual(first.settings);
  });

  it('troca o caminho antigo do nosso hook sem duplicar', () => {
    const old = mergeDelegationHooks({}, 'node "/velho/delegation-guard.mjs"').settings;
    const { settings, changed } = mergeDelegationHooks(old, CMD);
    expect(changed).toBe(true);
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect((hooks.PreToolUse[0] as { hooks: { command: string }[] }).hooks[0].command).toBe(CMD);
  });

  it('não mexe se "hooks" tem formato desconhecido', () => {
    const base: Settings = { hooks: 'nope' };
    expect(mergeDelegationHooks(base, CMD).changed).toBe(false);
  });

  it('isOurHook reconhece pelo nome do arquivo', () => {
    expect(isOurHook({ type: 'command', command: `node "/x/${HOOK_SCRIPT_NAME}"` })).toBe(true);
    expect(isOurHook({ type: 'command', command: 'node outro.mjs' })).toBe(false);
  });
});

describe('script de hook (execução real)', () => {
  let tmp: ReturnType<typeof tempDir>;
  let scriptPath: string;
  beforeEach(() => {
    tmp = tempDir();
    scriptPath = join(tmp.dir, 'frinus-hooks', HOOK_SCRIPT_NAME);
    mkdirSync(join(tmp.dir, 'frinus-hooks'), { recursive: true });
    writeFileSync(scriptPath, HOOK_SCRIPT_SOURCE);
    chmodSync(scriptPath, 0o755);
    mkdirSync(join(tmp.dir, 'agents'), { recursive: true });
    writeFileSync(join(tmp.dir, 'agents', 'frinus.md'), FRINUS_MD);
  });
  afterEach(() => tmp.cleanup());

  const runHook = (input: unknown): string =>
    execFileSync(process.execPath, [scriptPath], { input: JSON.stringify(input), encoding: 'utf8' });

  it('nega general-purpose', () => {
    const out = JSON.parse(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose' } }));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(DENY_REASON);
  });

  it('nega subagent_type ausente', () => {
    const out = JSON.parse(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { prompt: 'faça' } }));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('nega claude e Explore (sem caixa)', () => {
    for (const t of ['claude', 'Explore', 'EXPLORE']) {
      const out = JSON.parse(runHook({ hook_event_name: 'PreToolUse', tool_input: { subagent_type: t } }));
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    }
  });

  it('permite frinus-specialist e fork (sem saída = permitir)', () => {
    for (const t of ['frinus-specialist', 'fork', 'web-fetch', 'Plan']) {
      const out = runHook({ hook_event_name: 'PreToolUse', tool_input: { subagent_type: t } });
      expect(out.trim()).toBe('');
    }
  });

  it('SessionStart(compact) devolve o bloco + reorient com o agentId da conta', () => {
    const out = JSON.parse(runHook({ hook_event_name: 'SessionStart', source: 'compact' }));
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain(DELEGATION_BLOCK);
    expect(out.hookSpecificOutput.additionalContext).toContain('agent_reorient(agent_id="7901b410-8832-486f-bf00-b68f64877173")');
  });

  it('não quebra com stdin inválido (não bloqueia)', () => {
    const out = execFileSync(process.execPath, [scriptPath], { input: '{quebrado', encoding: 'utf8' });
    expect(out.trim()).toBe('');
  });
});

describe('installDelegationGuards (ponta a ponta)', () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  beforeEach(() => {
    tmp = tempDir();
    home = tmp.dir;
  });
  afterEach(() => tmp.cleanup());

  const account = (dir: string, withFrinus = true) => {
    mkdirSync(join(dir, 'agents'), { recursive: true });
    if (withFrinus) {
      writeFileSync(join(dir, 'agents', 'frinus.md'), FRINUS_MD);
      writeFileSync(join(dir, 'agents', 'frinus-specialist.md'), SPECIALIST_MD);
    }
  };

  it('instala em uma conta com frinus.md: script + settings (backup) + frinus.md', () => {
    const dir = join(home, '.claude-rdx');
    account(dir);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'carl.sh' }] }] } }));

    const [res] = installDelegationGuards(home, { dirs: [dir], now: new Date('2026-11-26T10:00:00Z') });
    expect(res.error).toBeUndefined();
    expect(res.scriptWritten).toBe(true);
    expect(res.settingsChanged).toBe(true);
    expect(res.frinusMdChanged).toBe(true);
    expect(res.backup).toBeTruthy();

    // script gravado e executável
    const scriptPath = join(dir, 'frinus-hooks', HOOK_SCRIPT_NAME);
    expect(readFileSync(scriptPath, 'utf8')).toBe(HOOK_SCRIPT_SOURCE);

    // settings preserva o hook do CARL e aponta para o script desta conta
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(settings.model).toBe('x');
    expect(settings.hooks.PreToolUse).toContainEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: 'carl.sh' }] });
    const ourGroup = settings.hooks.PreToolUse.find((g: { matcher: string }) => g.matcher === 'Agent|Task');
    expect(ourGroup.hooks[0].command).toContain(scriptPath);
    expect(settings.hooks.SessionStart[0].matcher).toBe('compact');

    // frinus.md com o bloco
    expect(readFileSync(join(dir, 'agents', 'frinus.md'), 'utf8')).toContain(BLOCK_START);

    // backup preserva o original
    expect(existsSync(res.backup as string)).toBe(true);
  });

  it('é idempotente: segunda passada não muda nada', () => {
    const dir = join(home, '.claude');
    account(dir);
    installDelegationGuards(home, { dirs: [dir] });
    const [res2] = installDelegationGuards(home, { dirs: [dir] });
    expect(res2.scriptWritten).toBe(false);
    expect(res2.settingsChanged).toBe(false);
    expect(res2.frinusMdChanged).toBe(false);
    expect(res2.specialistChanged).toBe(false);
  });

  it('pula contas sem agents/frinus.md', () => {
    const dir = join(home, '.claude-vazia');
    account(dir, false);
    const [res] = installDelegationGuards(home, { dirs: [dir] });
    expect(res.skipped).toBeTruthy();
    expect(existsSync(join(dir, 'frinus-hooks'))).toBe(false);
  });

  it('dry-run não grava nada', () => {
    const dir = join(home, '.claude');
    account(dir);
    const [res] = installDelegationGuards(home, { dirs: [dir], dryRun: true });
    expect(res.scriptWritten).toBe(true); // reporta que gravaria
    expect(existsSync(join(dir, 'frinus-hooks', HOOK_SCRIPT_NAME))).toBe(false);
    expect(existsSync(join(dir, 'settings.json'))).toBe(false);
  });
});
