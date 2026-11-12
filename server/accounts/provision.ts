// "Adicionar conta Frinus" pela interface: cria um config dir do Claude Code (~/.claude-<alias>), liga o MCP do
// Frinus (frinus-mcp no .claude.json, com a chave só no arquivo) e deixa a conta pronta para o `--agent frinus`
// (CLAUDE.md de partida + agentes frinus/frinus-specialist), espelhando o install.sh do frinus-mcp — porém em Node,
// sem subprocesso e sem passar a chave por argv.
//
// Segurança da chave: ela chega pelo corpo do POST (rota local), é GRAVADA apenas no .claude.json da conta
// (como o próprio Claude Code faria) e NUNCA é logada nem devolvida ao navegador. Nada aqui imprime a chave.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isFrinusMcpServer } from './detect';

/** Nome do servidor MCP (mantém igual ao instalador e ao leitor de chave em http/frinus.ts). */
const MCP_NAME = 'frinus-mcp';
/** Control Plane do Frinus (confirma a chave e descobre a empresa/orquestrador). Sobrescreva com FRINUS_OFFICE_CP_URL. */
const CP_URL = (process.env.FRINUS_OFFICE_CP_URL || 'https://frinus-api.rdxsec.com.br').replace(/\/+$/, '');
const VERIFY_TIMEOUT_MS = 12_000;

/** Alias: minúsculas, dígitos, hífen/sublinhado; começa por letra/dígito; até 32. Vira a pasta ".claude-<alias>". */
const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Chave do Frinus (mesmo formato do instalador). */
const KEY_RE = /^sk-frinus-[A-Za-z0-9_-]{10,}$/;

export class ProvisionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ProvisionInput {
  alias: unknown;
  apiKey: unknown;
  home: string;
  /** Confere a chave no Control Plane antes de gravar (padrão: sim). Em rede ruim, segue sem bloquear. */
  verify?: boolean;
}

export interface ProvisionResult {
  id: string;
  dir: string;
  alias: string;
  organization?: string;
  orchestratorId?: string;
  /** A chave foi confirmada no Control Plane (true), não pôde ser confirmada por rede (undefined). */
  verified?: boolean;
}

function cleanAlias(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/^\.?claude[-_.]?/, '') : '';
  if (!ALIAS_RE.test(s)) {
    throw new ProvisionError(400, 'apelido inválido: use letras minúsculas, números, hífen ou sublinhado (ex.: "monetizze")');
  }
  return s;
}

function cleanKey(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new ProvisionError(400, 'cole a chave do Frinus (começa com sk-frinus-)');
  if (!KEY_RE.test(s)) throw new ProvisionError(400, 'essa chave não parece ser do Frinus (ela começa com sk-frinus-)');
  return s;
}

/** Confirma a chave no Control Plane e devolve empresa + orquestrador; distingue chave inválida de rede ruim. */
async function verifyKey(key: string): Promise<{ organization?: string; orchestratorId?: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), VERIFY_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${CP_URL}/api/v1/templates/mcp-config`, { headers: { 'X-API-Key': key, Accept: 'application/json' }, signal: ac.signal });
  } catch {
    return {}; // sem internet / CP fora: não bloqueia (o MCP valida em uso)
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new ProvisionError(401, 'a chave não foi reconhecida pelo Frinus — confira se copiou a chave inteira');
  if (res.status < 200 || res.status >= 300) return {};
  const j = (await res.json().catch(() => ({}))) as { organization?: { name?: unknown }; orchestrator_id?: unknown };
  const organization = typeof j.organization?.name === 'string' && j.organization.name.trim() ? j.organization.name.trim() : undefined;
  const orchestratorId = typeof j.orchestrator_id === 'string' && j.orchestrator_id.trim() ? j.orchestrator_id.trim() : undefined;
  return { organization, orchestratorId };
}

function readJsonFile(file: string): Record<string, unknown> {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, unknown>;
  } catch {
    // inexistente ou inválido: começa do zero
  }
  return {};
}

/** Já existe uma conta com o MCP do Frinus neste dir? (idempotência / evita sobrescrever outra conta.) */
function hasFrinus(dir: string): boolean {
  const servers = readJsonFile(join(dir, '.claude.json')).mcpServers;
  if (!servers || typeof servers !== 'object') return false;
  return Object.entries(servers as Record<string, unknown>).some(([name, def]) => isFrinusMcpServer(name, def));
}

const BEGIN = '<!-- FRINUS:INICIO (gerado automaticamente — não edite entre estas marcas) -->';
const END = '<!-- FRINUS:FIM -->';

function claudeMdBlock(orchestratorId?: string): string {
  const body = orchestratorId
    ? `Você é o agente ${orchestratorId}.\nAntes de qualquer tarefa não-trivial, chame agent_bootstrap(agent_id="${orchestratorId}") e adote identity + system_prompt + runtime como suas instruções.\nAo saturar o contexto ou a cada N respostas, chame agent_reorient(agent_id="${orchestratorId}").\nAo concluir algo relevante, salve com memory_store.\nMemória indisponível? Avise: "Frinus offline — memória reduzida."`
    : `Você tem memória de longo prazo pelo Frinus. Antes de qualquer tarefa não-trivial, recupere contexto com memory_search. Ao concluir algo relevante, salve com memory_store.\nMemória indisponível? Avise: "Frinus offline — memória reduzida."`;
  return `${BEGIN}\n${body}\n${END}\n`;
}

/** Grava/atualiza SÓ o bloco FRINUS do CLAUDE.md, preservando o resto. */
function writeClaudeMd(dir: string, orchestratorId?: string): void {
  const file = join(dir, 'CLAUDE.md');
  const block = claudeMdBlock(orchestratorId);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // novo arquivo
  }
  if (text.includes('FRINUS:INICIO')) {
    text = text.replace(/<!-- FRINUS:INICIO[\s\S]*?<!-- FRINUS:FIM -->\n?/, block);
  } else {
    text = text ? `${text.replace(/\s*$/, '')}\n\n${block}` : block;
  }
  writeFileSync(file, text, { mode: 0o600 });
}

function writeAgents(dir: string, orchestratorId: string): void {
  const agentsDir = join(dir, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, 'frinus.md'),
    `---
name: frinus
description: "orquestração, roteamento e coordenação de agentes especializados"
agentId: ${orchestratorId}
is_orchestrator: true
can_delegate: true
model: inherit
color: "violet"
language: pt-BR
---

> REGRA ZERO — MCP é obrigatório. O Frinus é sua memória de longo prazo, identidade e inteligência. Antes de qualquer tarefa não-trivial confirme que as ferramentas de memória estão acessíveis; se não, avise: "Frinus offline — memória reduzida." e opere com cautela.

## Regra de Boot (fonte única)
Você é o agente \`${orchestratorId}\`. Antes de responder qualquer mensagem não-trivial, chame agent_bootstrap(agent_id="${orchestratorId}") e adote identity + system_prompt + runtime como suas instruções. A cada reorient_every_n respostas (ou ao saturar contexto) chame agent_reorient(agent_id="${orchestratorId}").
`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(agentsDir, 'frinus-specialist.md'),
    `---
name: frinus-specialist
description: "Subagent camaleão Frinus. Recebe AGENT_ID na 1ª linha do prompt, faz agent_bootstrap e se personifica como o especialista. Use para delegar qualquer especialista do time no CLI."
model: inherit
color: "violet"
language: pt-BR
---

> REGRA ZERO — MCP é obrigatório. Confirme que as ferramentas de memória estão acessíveis; se não, avise "Frinus offline — memória reduzida." e opere com cautela.

## Boot dinâmico
Sua identidade vem do AGENT_ID passado no prompt. Leia o AGENT_ID na 1ª linha, chame agent_bootstrap(agent_id="<o AGENT_ID>") e adote identity + system_prompt + runtime. Se houver TASK_ID, reporte com task_update. Devolva resultado técnico autocontido e salve aprendizados com memory_store.
`,
    { mode: 0o600 },
  );
}

/**
 * Cria/atualiza a conta. Idempotente: uma conta que já tem o MCP do Frinus é recusada (409) para não sobrescrever
 * uma chave existente por engano. A chave só é gravada no .claude.json; nunca é logada nem devolvida.
 */
export async function provisionFrinusAccount(input: ProvisionInput): Promise<ProvisionResult> {
  const alias = cleanAlias(input.alias);
  const key = cleanKey(input.apiKey);
  const dir = resolve(input.home, `.claude-${alias}`);
  if (existsSync(dir) && hasFrinus(dir)) {
    throw new ProvisionError(409, `já existe uma conta Frinus em ~/.claude-${alias} — escolha outro apelido`);
  }

  let verified: boolean | undefined;
  let organization: string | undefined;
  let orchestratorId: string | undefined;
  if (input.verify !== false) {
    const v = await verifyKey(key); // lança ProvisionError(401) se a chave for recusada
    organization = v.organization;
    orchestratorId = v.orchestratorId;
    verified = true;
  }

  // Estrutura mínima para o detector reconhecer o config dir (projects/) e o MCP com a chave só no arquivo.
  mkdirSync(join(dir, 'projects'), { recursive: true });
  const cfgFile = join(dir, '.claude.json');
  const cfg = readJsonFile(cfgFile);
  const servers = (cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {}) as Record<string, unknown>;
  servers[MCP_NAME] = { command: 'npx', args: ['-y', 'frinus-mcp@latest'], env: { FRINUS_API_KEY: key } };
  cfg.mcpServers = servers;
  writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });

  writeClaudeMd(dir, orchestratorId);
  if (orchestratorId) writeAgents(dir, orchestratorId);

  const result: ProvisionResult = { id: `.claude-${alias}`, dir, alias };
  if (organization) result.organization = organization;
  if (orchestratorId) result.orchestratorId = orchestratorId;
  if (verified !== undefined) result.verified = verified;
  return result;
}
