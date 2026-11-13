import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearFrinusIdentityCache, frinusAccountsForTest, frinusIdentity } from './frinus';

const KEY = 'sk-frinus-teste-123';

function fakeFetch(routes: Record<string, { status: number; body: unknown }>, calls: string[] = []) {
  return async (url: string, init: { headers: Record<string, string> }) => {
    calls.push(url);
    expect(init.headers['X-API-Key']).toBe(KEY);
    const hit = Object.entries(routes).find(([suffix]) => url.endsWith(suffix));
    if (!hit) throw new Error('rede fora');
    return { status: hit[1].status, json: async () => hit[1].body };
  };
}

afterEach(() => clearFrinusIdentityCache());

describe('frinusIdentity', () => {
  it('usa o e-mail do /auth/me e o nome da empresa do Control Plane', async () => {
    const f = fakeFetch({
      '/auth/me': { status: 200, body: { email: 'ana@rdx.com', org_slug: 'rdx' } },
      '/api/v1/templates/mcp-config': { status: 200, body: { organization: { name: 'RDX Security' } } },
    });
    expect(await frinusIdentity(KEY, 0, f)).toEqual({ email: 'ana@rdx.com', organization: 'RDX Security' });
  });

  it('sem o Control Plane, cai no slug da empresa', async () => {
    const f = fakeFetch({ '/auth/me': { status: 200, body: { email: 'ana@rdx.com', org_slug: 'rdx' } } });
    expect(await frinusIdentity(KEY, 0, f)).toEqual({ email: 'ana@rdx.com', organization: 'rdx' });
  });

  it('chave recusada ou sem rede: null', async () => {
    const f = fakeFetch({ '/auth/me': { status: 401, body: {} }, '/api/v1/templates/mcp-config': { status: 401, body: {} } });
    expect(await frinusIdentity(KEY, 0, f)).toBeNull();
  });

  it('guarda em cache por 10 min', async () => {
    const calls: string[] = [];
    const f = fakeFetch({ '/auth/me': { status: 200, body: { email: 'ana@rdx.com' } } }, calls);
    await frinusIdentity(KEY, 0, f);
    await frinusIdentity(KEY, 5 * 60_000, f);
    expect(calls).toHaveLength(2); // uma rodada (2 URLs)
    await frinusIdentity(KEY, 11 * 60_000, f);
    expect(calls).toHaveLength(4);
  });
});

describe('contas do seletor de memória', () => {
  function account(home: string, id: string, key?: string, server = 'frinus-mcp') {
    const dir = join(home, id);
    mkdirSync(dir, { recursive: true });
    if (key) writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { [server]: { env: { FRINUS_API_KEY: key } } } }));
    return { id, dir, detected: { email: `${id}@claude.ai`, organization: 'Org do Claude' } };
  }

  it('mostra a identidade Frinus, não a do Claude; sem rede, só o rótulo local', async () => {
    const home = mkdtempSync(join(tmpdir(), 'frinus-acc-'));
    const accs = [account(home, '.claude-a', 'sk-frinus-a'), account(home, '.claude-b', 'sk-frinus-b'), account(home, '.claude-c')];
    const list = await frinusAccountsForTest({ accounts: () => accs, home }, async (key) =>
      key === 'sk-frinus-a' ? { email: 'ana@rdx.com', organization: 'RDX Security' } : null,
    );
    expect(list).toEqual([
      { id: '.claude-b', label: '.claude-b@claude.ai', isDefault: false },
      { id: '.claude-a', label: 'ana@rdx.com', organization: 'RDX Security', isDefault: false },
    ]);
    expect(JSON.stringify(list)).not.toContain('Org do Claude');
    expect(JSON.stringify(list)).not.toContain('sk-frinus');
  });

  it('acha a chave com o servidor do Frinus com outro nome ("frinus"), não só "frinus-mcp"', async () => {
    const home = mkdtempSync(join(tmpdir(), 'frinus-acc-'));
    const accs = [account(home, '.claude-a', 'sk-frinus-a'), account(home, '.claude-sc', 'sk-frinus-sc', 'frinus')];
    const list = await frinusAccountsForTest({ accounts: () => accs, home }, async () => null);
    expect(list.map((a) => a.id).sort()).toEqual(['.claude-a', '.claude-sc']);
  });
});
