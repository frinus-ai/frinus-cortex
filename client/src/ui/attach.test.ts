import { describe, expect, it } from 'vitest';
import { formatPathForInsert, hasAttachment, pathFromFileUri, planAttach, type TransferLike } from './attach';

function tx(data: Record<string, string>, fileCount = 0): TransferLike {
  return { types: Object.keys(data), getData: (t) => data[t] ?? '', fileCount };
}

describe('hasAttachment', () => {
  it('intercepta arquivos e URIs, ignora texto puro', () => {
    expect(hasAttachment(['Files'])).toBe(true);
    expect(hasAttachment(['text/uri-list'])).toBe(true);
    expect(hasAttachment(['x-special/gnome-copied-files'])).toBe(true);
    expect(hasAttachment(['text/plain'])).toBe(false);
    expect(hasAttachment([])).toBe(false);
    expect(hasAttachment(undefined)).toBe(false);
  });
});

describe('pathFromFileUri', () => {
  it('decodifica file:// com caminho absoluto e percent-encoding', () => {
    expect(pathFromFileUri('file:///home/u/a%20b.pdf')).toBe('/home/u/a b.pdf');
    expect(pathFromFileUri('file:///home/u/doc.txt')).toBe('/home/u/doc.txt');
  });
  it('ignora recent:// e outros esquemas', () => {
    expect(pathFromFileUri('recent:///2bd3fa')).toBeUndefined();
    expect(pathFromFileUri('https://x/y')).toBeUndefined();
  });
});

describe('planAttach', () => {
  it('usa o caminho direto de um file:// (sem upload)', () => {
    const p = planAttach(tx({ 'text/uri-list': 'file:///home/u/a.pdf' }));
    expect(p).toEqual({ kind: 'paths', paths: ['/home/u/a.pdf'] });
  });

  it('prefere o x-special/gnome-copied-files (caminho real) ao uri-list com recent://', () => {
    const p = planAttach(
      tx({
        'x-special/gnome-copied-files': 'copy\nfile:///home/u/real.png',
        'text/uri-list': 'recent:///2bd3fa',
      }),
    );
    expect(p).toEqual({ kind: 'paths', paths: ['/home/u/real.png'] });
  });

  it('sobe os bytes quando só há arquivos (imagem colada)', () => {
    expect(planAttach(tx({ Files: '' }, 1))).toEqual({ kind: 'upload' });
  });

  it('sobe os bytes de um recent:// quando o clipboard ainda os traz', () => {
    expect(planAttach(tx({ 'text/uri-list': 'recent:///2bd3fa', Files: '' }, 1))).toEqual({ kind: 'upload' });
  });

  it('dá dica humana para recent:// sem bytes', () => {
    const p = planAttach(tx({ 'text/uri-list': 'recent:///2bd3fa' }, 0));
    expect(p.kind).toBe('hint');
  });

  it('não intercepta texto puro', () => {
    expect(planAttach(tx({ 'text/plain': 'oi' }, 0))).toEqual({ kind: 'none' });
  });

  it('deduplica caminhos repetidos entre gnome e uri-list', () => {
    const p = planAttach(
      tx({
        'x-special/gnome-copied-files': 'copy\nfile:///home/u/a.pdf',
        'text/uri-list': 'file:///home/u/a.pdf',
      }),
    );
    expect(p).toEqual({ kind: 'paths', paths: ['/home/u/a.pdf'] });
  });
});

describe('formatPathForInsert', () => {
  it('deixa caminhos simples como estão', () => {
    expect(formatPathForInsert('/home/u/a.pdf')).toBe('/home/u/a.pdf');
  });
  it('põe aspas em caminhos com espaço', () => {
    expect(formatPathForInsert('/home/u/a b.pdf')).toBe("'/home/u/a b.pdf'");
  });
  it('escapa aspas simples', () => {
    expect(formatPathForInsert("/home/u/it's.pdf")).toBe("'/home/u/it'\\''s.pdf'");
  });
});
