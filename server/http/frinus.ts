// Ponte do Frinus Córtex com a Memory Engine do Frinus (busca de memória, tarefas e saúde).
//
// A página nunca fala direto com a Memory Engine nem vê a chave: ela chama estas rotas locais, e o
// servidor injeta a X-API-Key da conta escolhida (lida do frinus-mcp no .claude.json daquela conta) só no
// cabeçalho da requisição de saída. A chave JAMAIS entra numa resposta, num log ou no browser.
//
// Rotas (todas sob /api/frinus, só pelo próprio computador):
//   GET  /api/frinus/accounts                 -> contas que têm uma chave do Frinus configurada (sem a chave)
//   POST /api/frinus/memory/search {account, query, limit?, universe_id?}  -> proxy POST /memories/search
//   GET  /api/frinus/tasks?account=&status=   -> proxy GET /tasks
//   GET  /api/frinus/health?account=          -> proxy GET /training/stats (prova que a chave funciona)
//   POST /api/frinus/pick-folder {start?}     -> abre o seletor de pasta NATIVO do SO e devolve o caminho escolhido
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tr } from '../../shared/i18n';
import { HttpError, readJson, sendJson } from './app';
import { isFrinusMcpServer } from '../accounts/detect';
import { ProvisionError, provisionFrinusAccount } from '../accounts/provision';
import { pickFolder } from './folder-picker';

/** URL da Memory Engine em produção (sobrescreva com FRINUS_CORTEX_MEMORY_URL; FRINUS_OFFICE_MEMORY_URL: legado). */
const MEMORY_URL = (process.env.FRINUS_CORTEX_MEMORY_URL || process.env.FRINUS_OFFICE_MEMORY_URL || 'https://frinus-memory.rdxsec.com.br').replace(/\/+$/, '');
/** Tempo máximo esperando a Memory Engine (a rede pode estar lenta; nunca pendura a página). */
const UPSTREAM_TIMEOUT_MS = 15_000;
const SEARCH_LIMIT_MAX = 50;
/** Control Plane (nome da empresa da chave); sobrescreva com FRINUS_CORTEX_CP_URL (FRINUS_OFFICE_CP_URL: legado). */
const CP_URL = (process.env.FRINUS_CORTEX_CP_URL || process.env.FRINUS_OFFICE_CP_URL || 'https://frinus-api.rdxsec.com.br').replace(/\/+$/, '');
/** Identidade Frinus de cada chave: guardada em memória por 10 min (falha: 1 min, para tentar de novo logo). */
const IDENTITY_TTL_MS = 10 * 60_000;
const IDENTITY_FAIL_TTL_MS = 60_000;
/** O seletor de conta não pode esperar a rede: cada consulta de identidade desiste em 5 s. */
const IDENTITY_TIMEOUT_MS = 5_000;

/** O mínimo de uma conta que esta rota precisa: id, pasta de config e metadados de exibição. */
export interface FrinusAccount {
  id: string;
  dir: string;
  detected: { name?: string; email?: string; organization?: string };
}

export interface FrinusRouteDeps {
  /** Contas conhecidas agora (AccountsService.entries()); só as do Claude Code têm .claude.json. */
  accounts: () => readonly FrinusAccount[];
  /** $HOME, para achar o .claude.json da conta padrão (e criar ~/.claude-<alias> em "Adicionar conta"). */
  home: string;
  /** Re-descobre as contas depois de criar uma nova, para ela aparecer na hora (AccountsService.rediscover). */
  rescan?: () => void;
  /** Instala o mod/plugins (permissões, mensagens, uso) na conta recém-criada; melhor esforço, nunca bloqueia. */
  installMod?: (dir: string) => void;
}

interface AccountSummary {
  id: string;
  label: string;
  organization?: string;
  isDefault: boolean;
}

function isDefaultDir(dir: string, home: string): boolean {
  return resolve(dir) === resolve(home, '.claude');
}

/**
 * Lê a X-API-Key do MCP do Frinus no .claude.json da conta (mcpServers[<servidor do Frinus>].env.FRINUS_API_KEY).
 * O servidor pode ter qualquer nome reconhecido por isFrinusMcpServer ("frinus-mcp", "frinus"...): a mesma regra que
 * decide quais contas aparecem no córtex. Antes só valia "frinus-mcp", e contas instaladas com o nome "frinus"
 * sumiam do seletor de conta. Lê a cada chamada (pega rotação de chave) e devolve só o valor — nunca é guardado.
 */
function readFrinusKey(dir: string, home: string): string | undefined {
  const candidates = isDefaultDir(dir, home) ? [join(home, '.claude.json'), join(dir, '.claude.json')] : [join(dir, '.claude.json')];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, { env?: Record<string, unknown> }> };
      const servers = j.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : {};
      // "frinus-mcp" primeiro (nome padrão do instalador); depois qualquer outro servidor do Frinus.
      const names = Object.keys(servers).sort((x, y) => Number(y === 'frinus-mcp') - Number(x === 'frinus-mcp'));
      for (const name of names) {
        if (!isFrinusMcpServer(name, servers[name])) continue;
        const key = servers[name]?.env?.FRINUS_API_KEY;
        if (typeof key === 'string' && key.trim()) return key.trim();
      }
    } catch {
      // JSON inválido (sendo gravado?): tenta o próximo candidato
    }
  }
  return undefined;
}

function accountLabel(acc: FrinusAccount): string {
  return acc.detected.email || acc.detected.name || acc.id;
}

/** Quem a chave é no Frinus: e-mail do usuário e nome da empresa (não a conta/organização do Claude). */
export interface FrinusIdentity {
  email?: string;
  organization?: string;
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

const identityCache = new Map<string, { until: number; value: Promise<FrinusIdentity | null> }>();

/** Limpa o cache de identidades (testes). */
export function clearFrinusIdentityCache(): void {
  identityCache.clear();
}

async function getJson(fetchImpl: FetchLike, url: string, key: string): Promise<Record<string, unknown> | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), IDENTITY_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { 'X-API-Key': key, Accept: 'application/json' }, signal: ac.signal });
    if (res.status < 200 || res.status >= 300) return null;
    const j = await res.json().catch(() => null);
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Identidade Frinus da chave: e-mail pela Memory Engine (/auth/me) e nome da empresa pelo Control Plane
 * (/api/v1/templates/mcp-config; sem ele, o slug do /auth/me). Cache por hash da chave — a chave em si nunca é
 * guardada, logada nem devolvida. Sem rede: null (o seletor cai no rótulo local).
 */
export function frinusIdentity(key: string, now = Date.now(), fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<FrinusIdentity | null> {
  const id = createHash('sha256').update(key).digest('hex');
  const hit = identityCache.get(id);
  if (hit && hit.until > now) return hit.value;
  const value = (async (): Promise<FrinusIdentity | null> => {
    const [me, cfg] = await Promise.all([getJson(fetchImpl, `${MEMORY_URL}/auth/me`, key), getJson(fetchImpl, `${CP_URL}/api/v1/templates/mcp-config`, key)]);
    const org = cfg?.organization && typeof cfg.organization === 'object' ? (cfg.organization as Record<string, unknown>) : undefined;
    const out: FrinusIdentity = {};
    const email = asString(me?.email) ?? asString(me?.username);
    if (email) out.email = email.trim();
    const organization = asString(org?.name) ?? asString(me?.org_slug);
    if (organization) out.organization = organization.trim();
    return out.email || out.organization ? out : null;
  })();
  const entry = { until: now + IDENTITY_TTL_MS, value };
  identityCache.set(id, entry);
  void value.then((v) => {
    if (!v && identityCache.get(id) === entry) entry.until = now + IDENTITY_FAIL_TTL_MS;
  });
  return value;
}

/**
 * Contas com chave do Frinus configurada (para o seletor); a conta padrão vem primeiro. O rótulo é a identidade
 * FRINUS da chave (e-mail + empresa); sem rede, o e-mail/nome da conta local, sem empresa (a organização que o
 * Claude Code detecta é a do Claude, não a do Frinus, e confundiria).
 */
async function frinusAccounts(deps: FrinusRouteDeps, identity: typeof frinusIdentity = frinusIdentity): Promise<AccountSummary[]> {
  const withKey = deps.accounts().flatMap((acc) => {
    const key = readFrinusKey(acc.dir, deps.home);
    return key ? [{ acc, key }] : [];
  });
  const ids = await Promise.all(withKey.map(({ key }) => identity(key).catch(() => null)));
  const out: AccountSummary[] = withKey.map(({ acc }, i) => {
    const who = ids[i];
    const summary: AccountSummary = { id: acc.id, label: who?.email ?? accountLabel(acc), isDefault: isDefaultDir(acc.dir, deps.home) };
    if (who?.organization) summary.organization = who.organization;
    return summary;
  });
  out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label));
  return out;
}

/** Só para testes: a listagem do seletor com uma identidade simulada. */
export const frinusAccountsForTest = frinusAccounts;

/** Resolve a chave da conta pedida; erro humano quando não dá. */
function keyFor(deps: FrinusRouteDeps, accountId: unknown): { key: string } {
  if (typeof accountId !== 'string' || !accountId.trim()) throw new HttpError(400, tr('escolha uma conta do Frinus'));
  const acc = deps.accounts().find((a) => a.id === accountId);
  if (!acc) throw new HttpError(404, tr('conta não encontrada neste computador'));
  const key = readFrinusKey(acc.dir, deps.home);
  if (!key) throw new HttpError(400, tr('esta conta não tem uma chave do Frinus configurada (frinus-mcp no .claude.json)'));
  return { key };
}

/** Chama a Memory Engine com a chave no cabeçalho (nunca na URL) e traduz erros de rede/tempo. */
async function callMemory(path: string, key: string, init: { method: string; body?: unknown }): Promise<{ status: number; data: unknown }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${MEMORY_URL}${path}`, {
      method: init.method,
      headers: { 'X-API-Key': key, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), Accept: 'application/json' },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ac.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new HttpError(504, tr('a memória do Frinus demorou demais para responder'));
    throw new HttpError(502, tr('não foi possível falar com a memória do Frinus'));
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => undefined);
  return { status: res.status, data };
}

/** Converte um erro de status da Memory Engine em mensagem humana (sem vazar detalhes internos). */
function upstreamError(status: number): HttpError {
  if (status === 401 || status === 403) return new HttpError(401, tr('a chave do Frinus desta conta é inválida ou expirou'));
  if (status === 429) return new HttpError(429, tr('limite de consultas do Frinus atingido hoje — tente mais tarde'));
  if (status === 404) return new HttpError(502, tr('recurso não encontrado na memória do Frinus'));
  return new HttpError(502, tr('a memória do Frinus respondeu com erro'));
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** Normaliza um resultado de /memories/search para o que o painel mostra (sem campos internos). */
function normalizeMemory(m: Record<string, unknown>): Record<string, unknown> {
  const meta = (m.metadata && typeof m.metadata === 'object' ? (m.metadata as Record<string, unknown>) : {}) as Record<string, unknown>;
  return {
    id: m.id,
    memory_type: m.memory_type,
    content: m.content,
    importance: m.importance,
    created_at: m.created_at,
    similarity: m.similarity ?? null,
    // Caminho na hierarquia: melhor esforço a partir do metadado (a busca em lista não resolve os nomes dos nós).
    context_path: asString(meta.context_path) ?? null,
    universe_id: m.universe_id ?? null,
  };
}

async function handleSearch(req: IncomingMessage, res: ServerResponse, deps: FrinusRouteDeps): Promise<void> {
  const body = (await readJson(req)) as { account?: unknown; query?: unknown; limit?: unknown; universe_id?: unknown } | null;
  const query = asString(body?.query);
  if (!query) throw new HttpError(400, tr('digite o que procurar'));
  const { key } = keyFor(deps, body?.account);
  const limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Number(body?.limit) || 10));
  const payload: Record<string, unknown> = { query_text: query, limit };
  if (asString(body?.universe_id)) payload.universe_id = body!.universe_id;
  const { status, data } = await callMemory('/memories/search', key, { method: 'POST', body: payload });
  if (status < 200 || status >= 300) throw upstreamError(status);
  const list = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  sendJson(res, 200, { results: list.map(normalizeMemory), count: list.length });
}

async function handleTasks(req: IncomingMessage, res: ServerResponse, url: URL, deps: FrinusRouteDeps): Promise<void> {
  req.resume();
  const { key } = keyFor(deps, url.searchParams.get('account'));
  const status = url.searchParams.get('status');
  const qs = status ? `?status=${encodeURIComponent(status)}&limit=25` : '?limit=25';
  const r = await callMemory(`/tasks${qs}`, key, { method: 'GET' });
  if (r.status < 200 || r.status >= 300) throw upstreamError(r.status);
  const d = (r.data && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : {}) as { tasks?: unknown; total?: unknown };
  const tasks = Array.isArray(d.tasks) ? (d.tasks as Record<string, unknown>[]) : [];
  sendJson(res, 200, {
    total: typeof d.total === 'number' ? d.total : tasks.length,
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, created_at: t.created_at, updated_at: t.updated_at })),
  });
}

async function handleHealth(req: IncomingMessage, res: ServerResponse, url: URL, deps: FrinusRouteDeps): Promise<void> {
  req.resume();
  const { key } = keyFor(deps, url.searchParams.get('account'));
  const r = await callMemory('/training/stats', key, { method: 'GET' });
  if (r.status < 200 || r.status >= 300) throw upstreamError(r.status);
  const d = (r.data && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : {}) as Record<string, unknown>;
  sendJson(res, 200, {
    ok: true,
    total_memories: d.total_memories ?? 0,
    by_type: d.by_type ?? {},
    by_layer: d.by_layer ?? {},
    recent_uploads: d.recent_uploads ?? 0,
    gaps: d.gaps ?? 0,
    conflicts: d.conflicts ?? 0,
  });
}

/**
 * "Adicionar conta Frinus": cria ~/.claude-<alias>, liga o MCP do Frinus (chave só no arquivo), instala o mod e
 * faz a conta aparecer na hora. A chave chega no corpo, nunca é logada nem devolvida.
 */
async function handleCreateAccount(req: IncomingMessage, res: ServerResponse, deps: FrinusRouteDeps): Promise<void> {
  const body = (await readJson(req)) as { alias?: unknown; apiKey?: unknown } | null;
  let result;
  try {
    result = await provisionFrinusAccount({ alias: body?.alias, apiKey: body?.apiKey, home: deps.home });
  } catch (err) {
    if (err instanceof ProvisionError) throw new HttpError(err.status, err.message);
    // Nunca propague o objeto de erro cru (poderia conter o corpo/chave); mensagem genérica.
    throw new HttpError(500, tr('não foi possível criar a conta'));
  }
  // Mod/plugins + uso (melhor esforço, em segundo plano: nunca segura a resposta nem falha a criação).
  try {
    deps.installMod?.(result.dir);
  } catch {
    // ignorado: a conta já existe; o mod também é aplicado pelo instalador/na próxima vez
  }
  deps.rescan?.();
  // Resposta SEM a chave: só o que a interface precisa para mostrar a conta nova.
  sendJson(res, 201, { ok: true, id: result.id, name: result.alias, organization: result.organization ?? null, verified: result.verified ?? null });
}

/** Abre o seletor de pasta nativo do SO (o servidor roda na sessão gráfica do usuário) e devolve o caminho. */
async function handlePickFolder(req: IncomingMessage, res: ServerResponse, deps: FrinusRouteDeps): Promise<void> {
  const body = (await readJson(req)) as { start?: unknown } | null;
  const start = typeof body?.start === 'string' && body.start.length < 4096 ? body.start : undefined;
  const r = await pickFolder(start, deps.home);
  if (r.kind === 'unavailable') return sendJson(res, 501, { error: tr('seletor de pasta indisponível neste computador') });
  sendJson(res, 200, r.kind === 'picked' ? { path: r.path } : { cancelled: true });
}

/**
 * Cria o manipulador das rotas /api/frinus (registrado no app.ts). Devolve `false` para caminhos que não
 * são dele (o roteador segue tentando); devolve `true` quando tratou a requisição.
 */
export function createFrinusRoutes(deps: FrinusRouteDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const fail = (res: ServerResponse, err: unknown) => {
    if (res.headersSent) return void res.destroy();
    if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
    else sendJson(res, 500, { error: tr('erro interno') });
  };
  return (req, res, url) => {
    const path = url.pathname;
    if (path !== '/api/frinus' && !path.startsWith('/api/frinus/')) return false;
    const method = req.method ?? 'GET';
    const isRead = method === 'GET' || method === 'HEAD';

    if (path === '/api/frinus/accounts') {
      if (method === 'POST') {
        handleCreateAccount(req, res, deps).catch((err) => fail(res, err));
      } else if (!isRead) {
        res.setHeader('Allow', 'GET, POST');
        sendJson(res, 405, { error: tr('método não permitido') });
      } else {
        req.resume();
        frinusAccounts(deps)
          .then((accounts) => sendJson(res, 200, { accounts }))
          .catch((err) => fail(res, err));
      }
      return true;
    }
    if (path === '/api/frinus/memory/search') {
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        sendJson(res, 405, { error: tr('método não permitido') });
      } else handleSearch(req, res, deps).catch((err) => fail(res, err));
      return true;
    }
    if (path === '/api/frinus/tasks') {
      if (!isRead) {
        res.setHeader('Allow', 'GET');
        sendJson(res, 405, { error: tr('método não permitido') });
      } else handleTasks(req, res, url, deps).catch((err) => fail(res, err));
      return true;
    }
    if (path === '/api/frinus/health') {
      if (!isRead) {
        res.setHeader('Allow', 'GET');
        sendJson(res, 405, { error: tr('método não permitido') });
      } else handleHealth(req, res, url, deps).catch((err) => fail(res, err));
      return true;
    }
    if (path === '/api/frinus/pick-folder') {
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        sendJson(res, 405, { error: tr('método não permitido') });
      } else handlePickFolder(req, res, deps).catch((err) => fail(res, err));
      return true;
    }
    sendJson(res, 404, { error: tr('rota desconhecida') });
    return true;
  };
}
