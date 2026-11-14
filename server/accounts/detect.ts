// Detecção das contas do Claude Code (um config dir por conta) e dos seus metadados.
// Node puro e sem dependências: também é importado por scripts/docker-up.ts (via tsx) no host.
// Uma pasta do Codex (CODEX_HOME, ex.: ~/.codex) também tem `sessions/` e fica de fora (isCodexHome): as contas
// do Codex são descobertas pela fonte do Codex e entram no AccountsService com `provider: 'codex'`.
//
// Privacidade: do .claude.json lemos SOMENTE o e-mail e a organização do perfil da conta
// (oauthAccount.{emailAddress, organizationName}) e o cache de uso (cachedUsageUtilization);
// dos arquivos de shell, SOMENTE as linhas `alias X='... claude ...'` (e `alias X='... codex ...'`, para as
// contas do Codex: ver sources/codex/accounts.ts). Credenciais nunca são lidas e nada disso vai para o log.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Provider } from '../../shared/types';
import { tr } from '../../shared/i18n';

export interface DetectedAccount {
  id: string;
  /** Ferramenta da conta; ausente = 'claude' (detectAccounts só devolve contas do Claude Code). */
  provider?: Provider;
  configDir: string;
  short: string;
  name: string;
  email?: string;
  organization?: string;
  plan?: string;
  color: string;
  cachedUsage?: unknown;
}

/** Paleta fixa e bem distinta, atribuída na ordem estável das contas. */
export const ACCOUNT_COLORS = ['#f08a3c', '#4aa8e8', '#5cc97b', '#a77bf3', '#f06fa0'] as const;

const RC_FILES = ['.zshrc', '.bashrc', '.zprofile', '.bash_profile'];

/** Override vindo de HABBLAUD_ACCOUNTS (o host passa os metadados prontos para o container). */
export interface AccountOverride {
  id?: string;
  /** Ferramenta da conta; ausente = 'claude'. As do Codex ficam fora da descoberta das contas do Claude Code. */
  provider?: Provider;
  configDir?: string;
  mountDir?: string;
  short?: string;
  name?: string;
  email?: string;
  organization?: string;
  plan?: string;
  color?: string;
  cachedUsage?: unknown;
}

export interface ClaudeAlias {
  /** Nome do alias, como digitado no shell (ex.: "d"). */
  name: string;
  /**
   * Pasta absoluta da variável do alias (CLAUDE_CONFIG_DIR; no Codex, CODEX_HOME); ausente = conta padrão
   * ($HOME/.claude; no Codex, a pasta padrão dele).
   */
  configDir?: string;
}

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Perfil "só Frinus" (FRINUS_ONLY): o escritório monitora SOMENTE as contas do Claude Code que têm o MCP do
 * Frinus configurado no .claude.json, e dá nome amigável pela organização (ou pela pasta). Ligado no perfil do
 * Frinus Córtex (frinus/cortex.env); ausente = comportamento normal do Habblaud (todas as contas). Local, para
 * não depender de ../config (que importa este módulo).
 */
export function frinusOnly(env: NodeJS.ProcessEnv): boolean {
  const v = env.FRINUS_ONLY?.trim();
  return !!v && /^(1|true|yes|sim|on)$/i.test(v);
}

/** Expande `~`, `$HOME` e `${HOME}` e devolve o caminho absoluto sem barra final. */
export function expandHome(p: string, home: string): string {
  const expanded = p
    .trim()
    .replace(/^~(?=\/|$)/, home)
    .replace(/\$\{HOME\}|\$HOME\b/g, home);
  const abs = resolve(expanded);
  return abs.length > 1 ? abs.replace(/\/+$/, '') : abs;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Pasta de ano (AAAA) dentro de sessions/: o Codex guarda os rollouts em sessions/AAAA/MM/DD/. */
const YEAR_DIR = /^\d{4}$/;

/**
 * A pasta é do Codex (um CODEX_HOME, ex.: ~/.codex)? Ela também tem `sessions/`; sem esta checagem viraria uma
 * conta do Claude Code vazia e o watcher leria `sessions/` como o registro de sessões. Só marcas que o Claude Code
 * nunca grava, conferidas pela EXISTÊNCIA (nada é aberto, nem `auth.json` nem `config.toml`):
 * - `sessions/AAAA/` (rollouts por data; o Claude Code guarda `sessions/<pid>.json` direto ali);
 * - `thread-writer-locks/` ou `archived_sessions/`;
 * - `config.toml` ou `auth.json`.
 * Com `projects/` (que o Codex não cria) é sempre do Claude Code: nenhuma conta que já funcionava deixa de valer.
 * Pasta inexistente ou vazia não é do Codex.
 */
export function isCodexHome(p: string): boolean {
  if (isDir(join(p, 'projects'))) return false;
  if (isDir(join(p, 'thread-writer-locks')) || isDir(join(p, 'archived_sessions'))) return true;
  if (isFile(join(p, 'config.toml')) || isFile(join(p, 'auth.json'))) return true;
  try {
    return readdirSync(join(p, 'sessions'), { withFileTypes: true }).some((e) => e.isDirectory() && YEAR_DIR.test(e.name));
  } catch {
    return false;
  }
}

/** Tem a cara de um config dir do Claude Code (`projects/` ou `sessions/`), sem olhar se é do Codex. */
function hasClaudeLayout(p: string): boolean {
  return isDir(join(p, 'projects')) || isDir(join(p, 'sessions'));
}

/** Config dir do Claude Code: `projects/` ou `sessions/`, e não é uma pasta do Codex. */
export function isClaudeDir(p: string): boolean {
  return hasClaudeLayout(p) && !isCodexHome(p);
}

export function isDefaultDir(dir: string, home: string): boolean {
  return resolve(dir) === resolve(home, '.claude');
}

export function parseAccountOverrides(raw: string | undefined): AccountOverride[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((o): o is AccountOverride => !!o && typeof o === 'object' && !Array.isArray(o));
  } catch {
    return [];
  }
}

/** Overrides das contas do Claude Code (sem `provider` ou com 'claude'); os do Codex ficam com a fonte dele. */
function claudeOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => o.provider === undefined || o.provider === 'claude');
}

/**
 * Config dirs observados. HABBLAUD_CLAUDE_DIRS (lista separada por vírgula) substitui tudo;
 * senão: diretórios `$HOME/.claude*` com `projects/` ou `sessions/`, mais CLAUDE_CONFIG_DIR
 * (também aceita lista) e os `mountDir` de HABBLAUD_ACCOUNTS que existirem.
 * Em todos os caminhos, pastas do Codex ficam de fora (isCodexHome; ver codexDirsRefused).
 * Ordem estável: a conta padrão primeiro, depois alfabética.
 */
export function discoverClaudeDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  return scanClaudeDirs(env, home).dirs;
}

/**
 * Pastas que a descoberta das contas do Claude Code encontrou (ou recebeu de HABBLAUD_CLAUDE_DIRS,
 * CLAUDE_CONFIG_DIR ou HABBLAUD_ACCOUNTS) e recusou por serem do Codex: para avisar quem as listou.
 */
export function codexDirsRefused(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  return scanClaudeDirs(env, home).codex;
}

function scanClaudeDirs(env: NodeJS.ProcessEnv, home: string): { dirs: string[]; codex: string[] } {
  const codex: string[] = [];
  /** Fora se for do Codex (anotado em `codex`). */
  const notCodex = (p: string) => {
    if (!isCodexHome(p)) return true;
    codex.push(p);
    return false;
  };
  const unique = (list: string[]) => [...new Set(list)];
  // Perfil "só Frinus": fica só com as contas que têm o MCP do Frinus (FRINUS_ONLY); senão, lista inteira.
  const keepFrinus = (list: string[]) => (frinusOnly(env) ? list.filter((d) => hasFrinusMcp(d, home)) : list);

  const override = splitList(env.HABBLAUD_CLAUDE_DIRS);
  if (override.length) {
    const dirs = unique(override.map((p) => expandHome(p, home)));
    return { dirs: keepFrinus(dirs.filter(notCodex)), codex };
  }

  const found: string[] = [];
  try {
    for (const ent of readdirSync(home, { withFileTypes: true })) {
      if (!ent.name.startsWith('.claude')) continue;
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const p = join(home, ent.name);
      // Só Frinus: conta recém-instalada (MCP ligado, ainda sem projects/ nem sessions/) já aparece.
      if ((hasClaudeLayout(p) || (frinusOnly(env) && hasFrinusMcp(p, home))) && notCodex(p)) found.push(p);
    }
  } catch {
    // $HOME ilegível (ex.: container sem home): segue com as outras fontes
  }
  for (const p of splitList(env.CLAUDE_CONFIG_DIR)) {
    const abs = expandHome(p, home);
    if (isDir(abs) && notCodex(abs)) found.push(abs);
  }
  for (const o of claudeOverrides(env.HABBLAUD_ACCOUNTS)) {
    if (typeof o.mountDir !== 'string') continue;
    if (hasClaudeLayout(o.mountDir) && notCodex(o.mountDir)) found.push(expandHome(o.mountDir, home));
  }
  const dirs = unique(found.map((p) => expandHome(p, home)));
  dirs.sort((a, b) => {
    const da = isDefaultDir(a, home) ? 0 : 1;
    const db = isDefaultDir(b, home) ? 0 : 1;
    return da - db || a.localeCompare(b);
  });
  return { dirs: keepFrinus(dirs), codex: unique(codex.map((p) => expandHome(p, home))) };
}

const ALIAS_RE = /^\s*alias\s+([A-Za-z0-9_][A-Za-z0-9_.-]*)=(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\s*(?:#.*)?$/;
/** O que identifica o alias de cada ferramenta: o comando invocado e a variável com a pasta da conta. */
const ALIAS_TOOLS: Record<Provider, { invokes: RegExp; dir: RegExp }> = {
  claude: {
    invokes: /(?:^|[\s;&|(])(?:[\w.~/-]*\/)?claude(?=$|[\s;&|)])/,
    dir: /\bCLAUDE_CONFIG_DIR=(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/,
  },
  codex: {
    invokes: /(?:^|[\s;&|(])(?:[\w.~/-]*\/)?codex(?=$|[\s;&|)])/,
    dir: /\bCODEX_HOME=(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/,
  },
};

/**
 * Extrai os aliases de shell que invocam a ferramenta (`claude` ou `codex`), com a pasta da conta (CLAUDE_CONFIG_DIR
 * ou CODEX_HOME). Considera SOMENTE linhas `alias NOME='...'` (ou com aspas duplas); qualquer outra linha é ignorada.
 */
export function parseToolAliases(text: string, home: string, tool: Provider): ClaudeAlias[] {
  const { invokes, dir: dirRe } = ALIAS_TOOLS[tool];
  const out: ClaudeAlias[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = ALIAS_RE.exec(line);
    if (!m) continue;
    const body = m[2] ?? m[3]?.replace(/\\(.)/g, '$1') ?? '';
    if (!invokes.test(body)) continue;
    const dir = dirRe.exec(body);
    const raw = dir ? (dir[1] ?? dir[2] ?? dir[3]) : undefined;
    out.push(raw ? { name: m[1], configDir: expandHome(raw, home) } : { name: m[1] });
  }
  return out;
}

/** Aliases de shell que invocam o `claude` (ver parseToolAliases). */
export function parseClaudeAliases(text: string, home: string): ClaudeAlias[] {
  return parseToolAliases(text, home, 'claude');
}

/** Lê os aliases da ferramenta (padrão: o `claude`) dos arquivos de inicialização do shell do usuário. */
export function readShellAliases(home: string, tool: Provider = 'claude'): ClaudeAlias[] {
  const out: ClaudeAlias[] = [];
  for (const f of RC_FILES) {
    try {
      out.push(...parseToolAliases(readFileSync(join(home, f), 'utf8'), home, tool));
    } catch {
      // arquivo inexistente/ilegível
    }
  }
  return out;
}

/**
 * Escolhe o atalho de cada conta: o alias mais curto (até 3 caracteres); empate = o primeiro declarado. Alias sem
 * pasta é da conta padrão (`defaultDir`; padrão $HOME/.claude).
 */
export function shortcutsByDir(aliases: ClaudeAlias[], home: string, defaultDir: string = resolve(home, '.claude')): Map<string, string> {
  const best = new Map<string, string>();
  for (const a of aliases) {
    if (a.name.length > 3) continue;
    const dir = a.configDir ?? defaultDir;
    const cur = best.get(dir);
    if (cur === undefined || a.name.length < cur.length) best.set(dir, a.name);
  }
  return new Map([...best].map(([dir, name]) => [dir, name.toUpperCase()]));
}

/**
 * Lê e parseia o .claude.json de um config dir (os mesmos candidatos de readGlobalConfig: para a conta padrão,
 * $HOME/.claude.json e depois <dir>/.claude.json). undefined se não existir ou for ilegível. Nunca loga nada.
 */
function readClaudeJson(dir: string, home: string): Record<string, unknown> | undefined {
  return readClaudeJsons(dir, home)[0];
}

/** Todos os .claude.json legíveis da conta, na ordem de readClaudeJson. */
function readClaudeJsons(dir: string, home: string): Record<string, unknown>[] {
  const candidates = isDefaultDir(dir, home) ? [join(home, '.claude.json'), join(dir, '.claude.json')] : [join(dir, '.claude.json')];
  const out: Record<string, unknown>[] = [];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (j && typeof j === 'object' && !Array.isArray(j)) out.push(j as Record<string, unknown>);
    } catch {
      // JSON inválido (sendo gravado?): tenta o próximo candidato
    }
  }
  return out;
}

/**
 * Uma entrada de `mcpServers` é o MCP do Frinus? Reconhecido pelo nome do servidor (`frinus`, `frinus-mcp`...),
 * pelo pacote invocado (`frinus-mcp` em command/args) ou pela env FRINUS_API_KEY. Olha SÓ nomes/estrutura:
 * nunca lê o VALOR de uma env (as chaves do vault ficam ali e não podem vazar).
 */
export function isFrinusMcpServer(name: string, def: unknown): boolean {
  if (/frinus/i.test(name)) return true;
  if (!def || typeof def !== 'object') return false;
  const d = def as Record<string, unknown>;
  const argv = Array.isArray(d.args) ? d.args.filter((a): a is string => typeof a === 'string') : [];
  const cmd = typeof d.command === 'string' ? d.command : '';
  if (/frinus-mcp/i.test([cmd, ...argv].join(' '))) return true;
  const env = d.env && typeof d.env === 'object' ? (d.env as Record<string, unknown>) : undefined;
  return !!env && Object.keys(env).some((k) => /^FRINUS_API_KEY$/i.test(k));
}

/** A conta (config dir) tem o MCP do Frinus configurado no .claude.json (mcpServers)? */
export function hasFrinusMcp(dir: string, home: string): boolean {
  // Conta padrão (~/.claude): o instalador liga o MCP com CLAUDE_CONFIG_DIR=~/.claude, então ele vai para
  // ~/.claude/.claude.json, enquanto ~/.claude.json pode existir sem mcpServers. Vale se QUALQUER um tiver.
  return readClaudeJsons(dir, home).some((j) => {
    const servers = j.mcpServers;
    if (!servers || typeof servers !== 'object') return false;
    return Object.entries(servers as Record<string, unknown>).some(([name, def]) => isFrinusMcpServer(name, def));
  });
}

/**
 * Alias da conta a partir do id/pasta: o nome da pasta SEM o prefixo ".claude-", exatamente como foi
 * dado na criação da conta. ".claude-rdx" -> "rdx", ".claude-super-maxi" -> "super-maxi". A pasta padrão
 * (".claude", sem sufixo) não gera nada (cai no "Conta X"). Sem capitalizar nem reformatar: é o alias cru.
 */
export function aliasFromId(id: string): string | undefined {
  const base = id.replace(/~\d+$/, ''); // tira o desambiguador (~2, ~3...)
  const m = /^\.?claude[-_.]?(.*)$/i.exec(base);
  const rest = (m ? m[1] : base).replace(/^[-_.]+/, '').trim();
  return rest || undefined;
}

interface GlobalConfigInfo {
  email?: string;
  organization?: string;
  cachedUsage?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Nome de organização que vale exibir. Contas pessoais recebem um nome gerado automaticamente
 * ("<e-mail>'s Organization"), que não diz nada e ainda aparece em inglês: fica de fora.
 */
export function meaningfulOrganization(organization: string | undefined, email: string | undefined): string | undefined {
  if (!organization) return undefined;
  const generic = /^(.+?)['’]s organi[sz]ation$/i.exec(organization.trim());
  if (generic && (!email || generic[1].trim().toLowerCase() === email.trim().toLowerCase() || generic[1].includes('@'))) return undefined;
  return organization;
}

/**
 * Lê do config global do Claude Code ($HOME/.claude.json para a conta padrão, <dir>/.claude.json
 * para as demais) apenas a identificação da conta e o cache de uso.
 */
export function readGlobalConfig(dir: string, home: string): GlobalConfigInfo {
  const candidates = isDefaultDir(dir, home) ? [join(home, '.claude.json'), join(dir, '.claude.json')] : [join(dir, '.claude.json')];
  let fallback: GlobalConfigInfo | undefined;
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      const profile = j.oauthAccount && typeof j.oauthAccount === 'object' ? (j.oauthAccount as Record<string, unknown>) : undefined;
      const cache = j.cachedUsageUtilization && typeof j.cachedUsageUtilization === 'object' ? j.cachedUsageUtilization : undefined;
      const email = str(profile?.emailAddress);
      const info: GlobalConfigInfo = {
        email,
        organization: meaningfulOrganization(str(profile?.organizationName), email),
        cachedUsage: cache,
      };
      if (profile) return info;
      fallback ??= info;
    } catch {
      // JSON inválido (sendo gravado?): tenta o próximo candidato
    }
  }
  return fallback ?? {};
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return (
    overrides.find((o) => o.id === id) ??
    overrides.find((o) => norm(o.mountDir) === dir) ??
    overrides.find((o) => norm(o.configDir) === dir)
  );
}

/** Ids das contas (basename do dir), desambiguados se dois dirs tiverem o mesmo nome. */
export function accountIds(dirs: string[]): string[] {
  const seen = new Map<string, number>();
  return dirs.map((d) => {
    const base = basename(d) || d;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}~${n}`;
  });
}

/**
 * Uma conta por config dir, NA MESMA ORDEM de `dirs`.
 * `configDir` é o caminho para exibição (no Docker, o do host, vindo de HABBLAUD_ACCOUNTS).
 */
export function detectAccounts(dirs: string[], opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = claudeOverrides(env.HABBLAUD_ACCOUNTS);
  const shortcuts = shortcutsByDir(readShellAliases(home), home);
  const ids = accountIds(dirs);
  // Perfil Frinus: sem override de nome, usa a organização e, sem ela, o nome da pasta ("RDX", "SuperMaxi").
  const frinus = frinusOnly(env);

  const partial = dirs.map((dir, i) => {
    const id = ids[i];
    const ov = matchOverride(overrides, id, resolve(dir), home);
    const cfg = readGlobalConfig(dir, home);
    return { dir, id, ov, cfg, short: str(ov?.short)?.slice(0, 3) ?? shortcuts.get(resolve(dir)) };
  });

  // Contas sem atalho detectado recebem A, B, C... (sem colidir com os atalhos já usados).
  const used = new Set(partial.map((p) => p.short).filter((s): s is string => !!s));
  let next = 0;
  const fallbackShort = () => {
    for (; next < 26; next++) {
      const letter = String.fromCharCode(65 + next);
      if (!used.has(letter)) {
        used.add(letter);
        return letter;
      }
    }
    return '?';
  };

  const resolved = partial.map((p) => {
    const email = str(p.ov?.email) ?? p.cfg.email;
    const organization = meaningfulOrganization(str(p.ov?.organization) ?? p.cfg.organization, email);
    return { ...p, email, organization };
  });

  return resolved.map((p, i) => {
    const short = p.short ?? fallbackShort();
    // Perfil Frinus: o nome é SEMPRE o alias da pasta (o que o usuário deu ao criar a conta, ex.: ".claude-rdx"
    // -> "rdx"), nunca a organização do oauthAccount. Ordem: override explícito > alias da pasta > "Conta X".
    // A organização continua guardada em acc.organization (chip/e-mail), só não vira mais o nome.
    const name = str(p.ov?.name) ?? (frinus ? aliasFromId(p.id) : undefined) ?? tr('Conta {0}', [short]);
    const acc: DetectedAccount = {
      id: p.id,
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name,
      color: str(p.ov?.color) ?? ACCOUNT_COLORS[i % ACCOUNT_COLORS.length],
    };
    const plan = str(p.ov?.plan);
    const cachedUsage = p.ov?.cachedUsage ?? p.cfg.cachedUsage;
    if (p.email) acc.email = p.email;
    if (p.organization) acc.organization = p.organization;
    if (plan) acc.plan = plan;
    if (cachedUsage !== undefined) acc.cachedUsage = cachedUsage;
    return acc;
  });
}
