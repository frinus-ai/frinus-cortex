import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test/fixtures';
import { healDefaultAccountMcp } from './heal';

const FRINUS = { command: 'npx', args: ['-y', 'frinus-mcp@latest'], env: { FRINUS_API_KEY: 'sk-frinus-teste' } };

describe('healDefaultAccountMcp', () => {
  let tmp: ReturnType<typeof tempDir>;
  let h: string;
  beforeEach(() => {
    tmp = tempDir();
    h = tmp.dir;
    mkdirSync(join(h, '.claude'), { recursive: true });
  });
  afterEach(() => tmp.cleanup());

  const outer = () => JSON.parse(readFileSync(join(h, '.claude.json'), 'utf8')) as Record<string, unknown>;

  it('copia o MCP de ~/.claude/.claude.json para ~/.claude.json, preservando o resto', () => {
    writeFileSync(join(h, '.claude', '.claude.json'), JSON.stringify({ mcpServers: { 'frinus-mcp': FRINUS } }));
    writeFileSync(join(h, '.claude.json'), JSON.stringify({ userID: 'x', mcpServers: { outro: { command: 'y' } } }));
    expect(healDefaultAccountMcp(h)).toEqual({ copied: ['frinus-mcp'] });
    expect(outer()).toEqual({ userID: 'x', mcpServers: { outro: { command: 'y' }, 'frinus-mcp': FRINUS } });
    expect(statSync(join(h, '.claude.json')).mode & 0o777).toBe(0o600);
    expect(healDefaultAccountMcp(h)).toEqual({ copied: [] }); // idempotente
  });

  it('cria ~/.claude.json se não existir', () => {
    writeFileSync(join(h, '.claude', '.claude.json'), JSON.stringify({ mcpServers: { 'frinus-mcp': FRINUS } }));
    expect(healDefaultAccountMcp(h).copied).toEqual(['frinus-mcp']);
    expect(outer()).toEqual({ mcpServers: { 'frinus-mcp': FRINUS } });
  });

  it('não mexe quando ~/.claude.json já tem um MCP do Frinus (outro nome ou outra chave)', () => {
    writeFileSync(join(h, '.claude', '.claude.json'), JSON.stringify({ mcpServers: { 'frinus-mcp': FRINUS } }));
    const ja = { mcpServers: { frinus: { command: 'npx', args: ['-y', 'frinus-mcp@latest'], env: { FRINUS_API_KEY: 'outra' } } } };
    writeFileSync(join(h, '.claude.json'), JSON.stringify(ja));
    expect(healDefaultAccountMcp(h)).toEqual({ copied: [] });
    expect(outer()).toEqual(ja);
  });

  it('sem MCP do Frinus em ~/.claude/.claude.json: nada a fazer', () => {
    writeFileSync(join(h, '.claude', '.claude.json'), JSON.stringify({ mcpServers: { outro: { command: 'y' } } }));
    expect(healDefaultAccountMcp(h)).toEqual({ copied: [] });
  });

  it('JSON inválido não lança: devolve o erro', () => {
    writeFileSync(join(h, '.claude', '.claude.json'), '{quebrado');
    const r = healDefaultAccountMcp(h);
    expect(r.copied).toEqual([]);
    expect(r.error).toBeTruthy();
  });
});
