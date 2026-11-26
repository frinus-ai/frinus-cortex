// Guarda de delegação do Frinus, instalado em cada conta do Claude Code que tenha agents/frinus.md.
//
// Problema: o orquestrador Frinus, no Claude Code, volta a delegar para o subagente `general-purpose`
// (e deixa de criar tasks) DEPOIS que o Claude Code compacta o contexto — a regra de delegação só vivia
// no resultado do agent_bootstrap, que a compactação descarta.
//
// Correção (automática no install.sh E no boot via heal, idempotente): para cada conta,
//   1) escreve um script de hook (<conta>/frinus-hooks/delegation-guard.mjs, Node puro, sem dependências);
//   2) registra dois hooks em <conta>/settings.json, preservando os hooks de terceiros (CARL, statusline...):
//        - PreToolUse (matcher "Agent|Task"): nega subagente genérico/ausente;
//        - SessionStart (matcher "compact"): reinjeta a regra de delegação + um agent_reorient;
//   3) insere/atualiza o bloco canônico em <conta>/agents/frinus.md entre marcadores (idempotente);
//   4) garante a nota anti-general-purpose em <conta>/agents/frinus-specialist.md.
//
// Este módulo só faz I/O de arquivos (nada de rede) e não importa nada de scripts/ — é compilado para
// dentro de dist/server e também é usado pelo CLI scripts/delegation-install.ts (via tsx).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { discoverClaudeDirs } from './detect';

// ---------------------------------------------------------------------------------------------
// Texto canônico (IDÊNTICO ao do backend — template GET /agents/{id}/claude-agent e payload do reorient).
// Não reescrever: a frente de backend injeta exatamente este bloco.
// ---------------------------------------------------------------------------------------------

/** Bloco canônico, entre os marcadores em agents/frinus.md e no additionalContext do SessionStart. */
export const DELEGATION_BLOCK = [
  '## Delegação no Claude Code (regra que sobrevive à compactação)',
  '- Para delegar a um especialista: `agent_list()` (uma vez por sessão; guarde o roster) → opcionalmente `task_create(assigned_agent_id=...)` → `Agent(subagent_type="frinus-specialist", prompt="AGENT_ID: <uuid>\\n[TASK_ID: <uuid>]\\n\\n<brief autocontido>")`.',
  '- **Nunca** use `general-purpose`, `claude`, `Explore` nem omita `subagent_type`: ou você faz, ou delega a um especialista via `frinus-specialist`.',
  '- Após uma compactação de contexto, chame `agent_reorient` antes de continuar.',
].join('\n');

/** Motivo da negação (exato), devolvido pelo hook PreToolUse ao Claude Code. */
export const DENY_REASON =
  'Delegação a agente genérico bloqueada pelo Frinus: chame agent_list() e delegue via ' +
  'Agent(subagent_type="frinus-specialist", prompt começando com AGENT_ID: <uuid>), ou faça você mesmo.';

export const BLOCK_START = '<!-- frinus:delegation:start -->';
export const BLOCK_END = '<!-- frinus:delegation:end -->';

/** Nome do arquivo do hook (reconhece o hook como "nosso" no settings.json, em qualquer pasta). */
export const HOOK_SCRIPT_NAME = 'delegation-guard.mjs';
/** Subpasta da conta onde o script é gravado (<conta>/frinus-hooks/delegation-guard.mjs). */
export const HOOK_DIR_NAME = 'frinus-hooks';

export const PRETOOL_EVENT = 'PreToolUse';
export const PRETOOL_MATCHER = 'Agent|Task';
export const SESSION_EVENT = 'SessionStart';
export const SESSION_MATCHER = 'compact';

// ---------------------------------------------------------------------------------------------
// Script do hook (Node puro, ESM, zero dependências; portátil Linux/macOS/WSL).
// O texto do bloco e o motivo vêm das constantes acima via JSON.stringify — fonte única da verdade.
// ---------------------------------------------------------------------------------------------

/** Código do script de hook gravado em cada conta. */
export function hookScriptSource(block: string = DELEGATION_BLOCK, denyReason: string = DENY_REASON): string {
  return `#!/usr/bin/env node
// Frinus Córtex — guarda de delegação. GERADO pelo Córtex; não edite à mão (é sobrescrito a cada atualização).
// PreToolUse(Agent|Task): nega subagente genérico/ausente. SessionStart(compact): reinjeta a regra + reorient.
// Node puro, sem dependências. Falha de forma segura (nunca derruba a chamada por erro próprio).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DELEGATION_BLOCK = ${JSON.stringify(block)};
const DENY_REASON = ${JSON.stringify(denyReason)};
// Tipos tratados como "genérico" (além do subagent_type ausente/vazio). Comparação sem caixa.
const GENERIC = new Set(['general-purpose', 'claude', 'explore']);

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Pasta da conta: este script vive em <conta>/${HOOK_DIR_NAME}/${HOOK_SCRIPT_NAME}. */
function configDir() {
  try {
    return dirname(dirname(fileURLToPath(import.meta.url)));
  } catch {
    return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  }
}

/** agentId do frontmatter de <conta>/agents/frinus.md (para o agent_reorient). */
function agentId() {
  try {
    const md = readFileSync(join(configDir(), 'agents', 'frinus.md'), 'utf8');
    const m = /^\\s*agentId:\\s*["']?([0-9a-fA-F-]{8,})["']?\\s*$/m.exec(md);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

function main() {
  let input = {};
  try {
    const raw = readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch {
    return; // stdin ilegível/ inválido: não bloqueia nada
  }
  const event = input.hook_event_name || (input.tool_input ? 'PreToolUse' : input.source ? 'SessionStart' : '');

  if (event === 'PreToolUse') {
    const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
    const t = typeof ti.subagent_type === 'string' ? ti.subagent_type.trim() : '';
    const generic = t === '' || GENERIC.has(t.toLowerCase());
    if (generic) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENY_REASON },
        }),
      );
    }
    return; // qualquer outro subagent_type passa (sem saída = permitir)
  }

  if (event === 'SessionStart') {
    const id = agentId();
    const extra = id ? DELEGATION_BLOCK + '\\nChame agora agent_reorient(agent_id="' + id + '")' : DELEGATION_BLOCK;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: extra } }));
  }
}

main();
`;
}

/** Código do script de hook (constante pronta). */
export const HOOK_SCRIPT_SOURCE = hookScriptSource();

// ---------------------------------------------------------------------------------------------
// Patch de agents/frinus.md (puro, idempotente)
// ---------------------------------------------------------------------------------------------

/** Bloco com marcadores, como gravado no .md. */
export function markedBlock(block: string = DELEGATION_BLOCK): string {
  return `${BLOCK_START}\n${block}\n${BLOCK_END}`;
}

/**
 * Insere ou substitui o bloco canônico em agents/frinus.md, entre os marcadores, DEPOIS da "Regra de Boot".
 * Idempotente; nunca mexe no frontmatter.
 */
export function patchFrinusMd(md: string, block: string = DELEGATION_BLOCK): string {
  const fresh = markedBlock(block);
  const start = md.indexOf(BLOCK_START);
  const end = md.indexOf(BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    // Já existe: substitui o conteúdo entre marcadores (inclusive).
    return md.slice(0, start) + fresh + md.slice(end + BLOCK_END.length);
  }
  // Não existe: insere logo após a seção "Regra de Boot" (antes da próxima "## ") ou, em último caso, no fim.
  const boot = /^##\s+Regra de Boot.*$/im.exec(md);
  if (boot) {
    const afterBoot = boot.index + boot[0].length;
    const nextHeading = /\n##\s+/.exec(md.slice(afterBoot));
    const at = nextHeading ? afterBoot + nextHeading.index : md.length;
    const before = md.slice(0, at).replace(/\s*$/, '');
    const after = md.slice(at);
    return `${before}\n\n${fresh}\n${after.startsWith('\n') ? after : `\n${after}`}`.replace(/\n{3,}/g, '\n\n');
  }
  return `${md.replace(/\s*$/, '')}\n\n${fresh}\n`;
}

// ---------------------------------------------------------------------------------------------
// Patch de agents/frinus-specialist.md (puro, idempotente)
// ---------------------------------------------------------------------------------------------

const SPECIALIST_NOTE = 'Nunca delegue a general-purpose: você É o especialista do AGENT_ID recebido.';

/**
 * Garante que a `description` do frontmatter continue em uma única linha e que o arquivo mencione que o
 * especialista não delega a general-purpose. Idempotente; não altera mais nada.
 */
export function patchSpecialistMd(md: string): string {
  let out = collapseFrontmatterDescription(md);
  if (!/general-purpose/i.test(out)) {
    out = `${out.replace(/\s*$/, '')}\n\n${SPECIALIST_NOTE}\n`;
  }
  return out;
}

/** Junta uma `description:` de frontmatter que tenha quebrado em várias linhas em uma só (se for o caso). */
function collapseFrontmatterDescription(md: string): string {
  if (!md.startsWith('---')) return md;
  const close = md.indexOf('\n---', 3);
  if (close === -1) return md;
  const fmEnd = close + 1; // posição do segundo '---'
  const front = md.slice(0, fmEnd);
  const rest = md.slice(fmEnd);
  const lines = front.split('\n');
  const idx = lines.findIndex((l) => /^description:\s*"/.test(l));
  if (idx === -1) return md;
  const first = lines[idx];
  // Já fecha na mesma linha? (aspas de fechamento depois da de abertura)
  const open = first.indexOf('"');
  if (first.indexOf('"', open + 1) !== -1) return md;
  // Junta até a linha que fecha as aspas.
  let j = idx + 1;
  const parts = [first];
  while (j < lines.length && !lines[j].includes('"')) {
    parts.push(lines[j].trim());
    j++;
  }
  if (j < lines.length) parts.push(lines[j].trim());
  const joined = parts.join(' ').replace(/\s+/g, ' ');
  const newLines = [...lines.slice(0, idx), joined, ...lines.slice(j + 1)];
  return newLines.join('\n') + rest;
}

// ---------------------------------------------------------------------------------------------
// Merge de hooks em settings.json (puro, idempotente, preserva hooks de terceiros)
// ---------------------------------------------------------------------------------------------

export type Settings = Record<string, unknown>;
type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/** Uma entrada de hook é nossa? (pelo nome do arquivo no command, em qualquer pasta). */
export function isOurHook(h: unknown): boolean {
  const r = rec(h);
  return !!r && typeof r.command === 'string' && r.command.includes(HOOK_SCRIPT_NAME);
}

/** Entrada do hook como o Claude Code a lê. */
export function hookEntry(command: string): Rec {
  return { type: 'command', command };
}

/** `node "<script>"`. nodeCmd entre aspas só se precisar. */
export function hookCommand(nodeCmd: string, scriptPath: string): string {
  const node = /^[\w@%+=:,./~-]+$/.test(nodeCmd) ? nodeCmd : quote(nodeCmd);
  return `${node} ${quote(scriptPath)}`;
}

function quote(p: string): string {
  if (/^[\w@%+=:,./~-]+$/.test(p)) return p;
  return /^[^"$`\\]*$/.test(p) ? `"${p}"` : `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Lista de grupos de um evento sem os nossos hooks (grupos que ficarem vazios saem). */
function withoutOurs(list: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const g of list) {
    const group = rec(g);
    if (!group || !Array.isArray(group.hooks)) {
      out.push(g);
      continue;
    }
    const kept = group.hooks.filter((h) => !isOurHook(h));
    if (kept.length === group.hooks.length) out.push(g);
    else if (kept.length) out.push({ ...group, hooks: kept });
  }
  return out;
}

/** Garante, num objeto hooks, o nosso grupo {matcher, hooks:[entry]} para um evento, sem duplicar. */
function ensureEvent(hooks: Rec, event: string, matcher: string, entry: Rec): boolean {
  const prev = hooks[event];
  if (prev !== undefined && !Array.isArray(prev)) return false; // formato desconhecido: não mexe
  const list = (prev as unknown[] | undefined) ?? [];
  const desired = [...withoutOurs(list), { matcher, hooks: [entry] }];
  if (JSON.stringify(list) === JSON.stringify(desired)) return false;
  hooks[event] = desired;
  return true;
}

export interface MergeResult {
  settings: Settings;
  changed: boolean;
}

/** Acrescenta/atualiza os dois hooks do Frinus, preservando os demais. Idempotente. */
export function mergeDelegationHooks(settings: Settings, command: string): MergeResult {
  if (settings.hooks !== undefined && !rec(settings.hooks)) return { settings, changed: false };
  const hooks: Rec = { ...(rec(settings.hooks) ?? {}) };
  const entry = hookEntry(command);
  const a = ensureEvent(hooks, PRETOOL_EVENT, PRETOOL_MATCHER, entry);
  const b = ensureEvent(hooks, SESSION_EVENT, SESSION_MATCHER, entry);
  if (!a && !b) return { settings, changed: false };
  return { settings: { ...settings, hooks }, changed: true };
}

// ---------------------------------------------------------------------------------------------
// settings.json: leitura, backup e gravação atômica (mesmas convenções do statusline/hooks installer)
// ---------------------------------------------------------------------------------------------

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

export function readSettings(file: string): { settings: Settings; raw?: string } | { error: string } {
  if (!existsSync(file)) return { settings: {} };
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return { error: (err as Error).message };
  }
  if (!raw.trim()) return { settings: {}, raw };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'não é um objeto JSON' };
    return { settings: parsed as Settings, raw };
  } catch {
    return { error: 'JSON inválido' };
  }
}

/** Backup (settings.json.frinus-backup-<data>) + gravação atômica preservando a permissão. Devolve o backup. */
export function writeSettings(file: string, settings: Settings, raw: string | undefined, now: Date): string | undefined {
  const mode = raw !== undefined ? statSync(file).mode & 0o777 : 0o600;
  const tmp = `${file}.frinus-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode });
  chmodSync(tmp, mode);
  let current: string | undefined;
  try {
    current = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      unlinkSync(tmp);
      throw err;
    }
  }
  if (current !== raw) {
    unlinkSync(tmp);
    throw new Error('o arquivo mudou desde a leitura; nada foi alterado');
  }
  let backup: string | undefined;
  if (current !== undefined) {
    backup = `${file}.frinus-backup-${stamp(now)}`;
    for (let i = 2; existsSync(backup); i++) backup = `${file}.frinus-backup-${stamp(now)}-${i}`;
    writeFileSync(backup, current, { mode: 0o600 });
  }
  renameSync(tmp, file);
  return backup;
}

// ---------------------------------------------------------------------------------------------
// Orquestração (efeitos). Idempotente; roda no install.sh (via CLI) e no boot (via heal).
// ---------------------------------------------------------------------------------------------

export interface AccountResult {
  dir: string;
  /** Conta pulada (sem agents/frinus.md). */
  skipped?: string;
  scriptWritten?: boolean;
  settingsChanged?: boolean;
  frinusMdChanged?: boolean;
  specialistChanged?: boolean;
  backup?: string;
  error?: string;
}

export interface InstallOptions {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Comando do node usado no hook (padrão: o node em execução — caminho absoluto estável). */
  nodeCmd?: string;
  /** Só calcula, não grava. */
  dryRun?: boolean;
  /** Lista de contas pronta (senão, descobre com discoverClaudeDirs). */
  dirs?: string[];
}

/** Escreve o arquivo só se o conteúdo for diferente. Devolve true se gravou. */
function writeIfChanged(file: string, content: string, mode: number): boolean {
  try {
    if (existsSync(file) && readFileSync(file, 'utf8') === content) return false;
  } catch {
    // ilegível: regrava
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, { mode });
  chmodSync(file, mode);
  return true;
}

/** Instala/atualiza o guarda de delegação em cada conta com agents/frinus.md. */
export function installDelegationGuards(home: string, opts: InstallOptions = {}): AccountResult[] {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const nodeCmd = opts.nodeCmd ?? process.execPath;
  const dryRun = !!opts.dryRun;
  const dirs = opts.dirs ?? discoverClaudeDirs(env, home);
  const results: AccountResult[] = [];

  for (const dir of dirs) {
    const res: AccountResult = { dir };
    const frinusMdPath = join(dir, 'agents', 'frinus.md');
    if (!existsSync(frinusMdPath)) {
      res.skipped = 'sem agents/frinus.md';
      results.push(res);
      continue;
    }
    try {
      const scriptPath = join(dir, HOOK_DIR_NAME, HOOK_SCRIPT_NAME);

      // 1) script do hook
      if (dryRun) {
        res.scriptWritten = !(existsSync(scriptPath) && safeRead(scriptPath) === HOOK_SCRIPT_SOURCE);
      } else {
        res.scriptWritten = writeIfChanged(scriptPath, HOOK_SCRIPT_SOURCE, 0o755);
      }

      // 2) settings.json
      const settingsFile = join(dir, 'settings.json');
      const read = readSettings(settingsFile);
      if ('error' in read) {
        res.error = `settings.json: ${read.error}`;
      } else {
        const command = hookCommand(nodeCmd, scriptPath);
        const merged = mergeDelegationHooks(read.settings, command);
        res.settingsChanged = merged.changed;
        if (merged.changed && !dryRun) {
          res.backup = writeSettings(settingsFile, merged.settings, read.raw, now);
        }
      }

      // 3) agents/frinus.md
      const md = safeRead(frinusMdPath) ?? '';
      const patched = patchFrinusMd(md);
      res.frinusMdChanged = patched !== md;
      if (res.frinusMdChanged && !dryRun) writeIfChanged(frinusMdPath, patched, 0o644);

      // 4) agents/frinus-specialist.md (só se existir)
      const specPath = join(dir, 'agents', 'frinus-specialist.md');
      if (existsSync(specPath)) {
        const spec = safeRead(specPath) ?? '';
        const specPatched = patchSpecialistMd(spec);
        res.specialistChanged = specPatched !== spec;
        if (res.specialistChanged && !dryRun) writeIfChanged(specPath, specPatched, 0o644);
      }
    } catch (err) {
      res.error = (err as Error).message;
    }
    results.push(res);
  }
  return results;
}

function safeRead(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Resumo de uma linha para o log de boot (undefined = nada a relatar). */
export function summarize(results: AccountResult[]): string | undefined {
  const touched = results.filter((r) => r.scriptWritten || r.settingsChanged || r.frinusMdChanged || r.specialistChanged);
  const errored = results.filter((r) => r.error);
  if (!touched.length && !errored.length) return undefined;
  const name = (d: string) => basename(d) || d;
  const parts: string[] = [];
  if (touched.length) parts.push(`atualizadas: ${touched.map((r) => name(r.dir)).join(', ')}`);
  if (errored.length) parts.push(`falhas: ${errored.map((r) => `${name(r.dir)} (${r.error})`).join('; ')}`);
  return parts.join(' · ');
}
