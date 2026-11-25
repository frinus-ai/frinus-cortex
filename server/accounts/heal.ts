// Reparo da conta padrão (~/.claude): até a v0.2.7 o instalador ligava o MCP do Frinus com
// CLAUDE_CONFIG_DIR=~/.claude, e o Claude Code gravava a conexão em ~/.claude/.claude.json. Só que o comando
// `frinus` e as sessões do Córtex abrem a conta padrão SEM essa variável, e aí o Claude lê ~/.claude.json —
// a memória não aparecia. Este reparo copia a(s) entrada(s) do Frinus para ~/.claude.json, sem tocar no resto.
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFrinusMcpServer } from './detect';

export interface HealResult {
  /** Nomes das conexões copiadas para ~/.claude.json (vazio = nada a fazer). */
  copied: string[];
  error?: string;
}

function readJson(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  const j = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
}

function servers(j: Record<string, unknown> | undefined): Record<string, unknown> {
  const s = j?.mcpServers;
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
}

/**
 * Se o MCP do Frinus existe em ~/.claude/.claude.json mas NÃO em ~/.claude.json, copia para ~/.claude.json.
 * Idempotente; nunca sobrescreve uma conexão do Frinus que já esteja em ~/.claude.json; nunca loga a chave.
 */
export function healDefaultAccountMcp(home: string): HealResult {
  const inner = join(home, '.claude', '.claude.json');
  const outer = join(home, '.claude.json');
  try {
    const fromInner = Object.entries(servers(readJson(inner))).filter(([n, d]) => isFrinusMcpServer(n, d));
    if (!fromInner.length) return { copied: [] };
    const outerJson = readJson(outer) ?? {};
    const outerServers = servers(outerJson);
    if (Object.entries(outerServers).some(([n, d]) => isFrinusMcpServer(n, d))) return { copied: [] };
    const copied: string[] = [];
    for (const [name, def] of fromInner) {
      if (name in outerServers) continue;
      outerServers[name] = def;
      copied.push(name);
    }
    if (!copied.length) return { copied };
    outerJson.mcpServers = outerServers;
    const tmp = `${outer}.frinus-heal.tmp`;
    writeFileSync(tmp, `${JSON.stringify(outerJson, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, outer);
    return { copied };
  } catch (err) {
    return { copied: [], error: err instanceof Error ? err.message : String(err) };
  }
}
