// Ponte do Frinus Office com a Memory Engine do Frinus (busca de memória, tarefas e saúde).
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
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tr } from '../../shared/i18n';
import { HttpError, readJson, sendJson } from './app';
import { ProvisionError, provisionFrinusAccount } from '../accounts/provision';

/** URL da Memory Engine em produção (sobrescreva com FRINUS_OFFICE_MEMORY_URL para apontar outra instância). */
const MEMORY_URL = (process.env.FRINUS_OFFICE_MEMORY_URL || 'https://frinus-memory.rdxsec.com.br').replace(/\/+$/, '');
/** Tempo máximo esperando a Memory Engine (a rede pode estar lenta; nunca pendura a página). */
const UPSTREAM_TIMEOUT_MS = 15_000;
const SEARCH_LIMIT_MAX = 50;

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
 * Lê a X-API-Key do frinus-mcp no .claude.json da conta (mcpServers["frinus-mcp"].env.FRINUS_API_KEY).
 * Lê a cada chamada (pega rotação de chave) e devolve só o valor para uso imediato — nunca é guardado.
 */
function readFrinusKey(dir: string, home: string): string | undefined {
  const candidates = isDefaultDir(dir, home) ? [join(home, '.claude.json'), join(dir, '.claude.json')] : [join(dir, '.claude.json')];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, { env?: Record<string, string> }> };
      const env = j.mcpServers?.['frinus-mcp']?.env;
      const key = env?.FRINUS_API_KEY;
      if (typeof key === 'string' && key.trim()) return key.trim();
    } catch {
      // JSON inválido (sendo gravado?): tenta o próximo candidato
    }
  }
  return undefined;
}

function accountLabel(acc: FrinusAccount): string {
  return acc.detected.email || acc.detected.name || acc.id;
}

/** Contas com chave do Frinus configurada (para o seletor); a conta padrão vem primeiro. */
function frinusAccounts(deps: FrinusRouteDeps): AccountSummary[] {
  const out: AccountSummary[] = [];
  for (const acc of deps.accounts()) {
    if (!readFrinusKey(acc.dir, deps.home)) continue;
    out.push({ id: acc.id, label: accountLabel(acc), organization: acc.detected.organization, isDefault: isDefaultDir(acc.dir, deps.home) });
  }
  out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label));
  return out;
}

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
        try {
          sendJson(res, 200, { accounts: frinusAccounts(deps) });
        } catch (err) {
          fail(res, err);
        }
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
    sendJson(res, 404, { error: tr('rota desconhecida') });
    return true;
  };
}
