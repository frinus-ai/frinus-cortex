import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseUpload, saveUpload, UPLOAD_MAX_BYTES, uploadsRoot } from './store';

describe('parseUpload', () => {
  it('aceita um arquivo base64 e sanitiza o nome', () => {
    const data = Buffer.from('oi').toString('base64');
    const r = parseUpload({ name: '../etc/pass wd.txt', type: 'text/plain', data });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.name).toBe('pass wd.txt'); // só a última parte, sem travessia de pasta
    expect(r.type).toBe('text/plain');
    expect(r.data.toString()).toBe('oi');
  });

  it('cai no octet-stream com tipo inválido e dá nome padrão sem nome', () => {
    const data = Buffer.from('x').toString('base64');
    const r = parseUpload({ data, type: 'não é/um; tipo' });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.type).toBe('application/octet-stream');
    expect(r.name).toBe('arquivo');
  });

  it('recusa corpo vazio', () => {
    expect(parseUpload({ name: 'x', data: '' })).toHaveProperty('error');
    expect(parseUpload({})).toHaveProperty('error');
  });

  it('recusa base64 inválido', () => {
    expect(parseUpload({ name: 'x', data: 'não-base64!!!' })).toHaveProperty('error');
  });

  it('recusa arquivo acima do limite', () => {
    const big = Buffer.alloc(UPLOAD_MAX_BYTES + 1).toString('base64');
    expect(parseUpload({ name: 'x', data: big })).toHaveProperty('error');
  });
});

describe('uploadsRoot', () => {
  it('usa ~/Frinus/anexos por padrão', () => {
    expect(uploadsRoot({ HOME: '/home/u' } as NodeJS.ProcessEnv)).toBe('/home/u/Frinus/anexos');
  });
  it('respeita FRINUS_ANEXOS_DIR', () => {
    expect(uploadsRoot({ HOME: '/home/u', FRINUS_ANEXOS_DIR: '/tmp/anexos' } as NodeJS.ProcessEnv)).toBe('/tmp/anexos');
  });
});

describe('saveUpload', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'frinus-up-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('grava o arquivo numa pasta do dia e devolve o caminho absoluto', () => {
    const at = new Date(2026, 10, 13, 9, 0, 0); // 2026-11-13
    const p = saveUpload(root, { name: 'nota.txt', type: 'text/plain', data: Buffer.from('conteúdo') }, at);
    expect(basename(dirname(p))).toBe('2026-11-13');
    expect(basename(p)).toBe('nota.txt');
    expect(readFileSync(p, 'utf8')).toBe('conteúdo');
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('não sobrescreve: em colisão de nome, cria um nome único', () => {
    const at = new Date(2026, 10, 13, 9, 0, 0);
    let n = 0;
    const ids = () => `aaaaaa${n++}`;
    const a = saveUpload(root, { name: 'img.png', type: 'image/png', data: Buffer.from('A') }, at, ids);
    const b = saveUpload(root, { name: 'img.png', type: 'image/png', data: Buffer.from('B') }, at, ids);
    expect(a).not.toBe(b);
    expect(basename(a)).toBe('img.png');
    expect(basename(b)).toMatch(/^img-[a-z0-9]+\.png$/);
    expect(readFileSync(a, 'utf8')).toBe('A');
    expect(readFileSync(b, 'utf8')).toBe('B');
  });
});
