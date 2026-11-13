// Arrastar e colar arquivos (e imagens) no terminal interativo (ui/ptypane.ts) e na caixa de mensagem (ui/composer.ts).
// O que acontece com o que o navegador entrega num drop/paste:
//   - file://  (gerenciador de arquivos pelo caminho real, ou "copiar" no GNOME): o caminho JÁ é local -> usa direto,
//     sem subir nada (é o que o Claude Code espera no prompt);
//   - bytes    (imagem colada da área de transferência, ou arrastar que só traz os bytes, ou recent:// que ainda traz
//     os bytes): sobe para POST /api/uploads, que grava em ~/Frinus/anexos e devolve o caminho;
//   - recent:// sem bytes (o que o GNOME às vezes manda ao colar): o navegador NÃO resolve isso -> dica humana.
// A parte de classificação (planAttach) é pura e testada em ui/attach.test.ts; o upload e a leitura de bytes usam as
// APIs do navegador.
import { tr } from '../../../shared/i18n';

/** Teto por arquivo, igual ao do servidor (server/uploads/store.ts: UPLOAD_MAX_BYTES). */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** Tipos num drop/paste que indicam arquivo (e não texto puro): só aí o terminal/caixa interceptam. */
const FILE_TYPES = ['Files', 'text/uri-list', 'x-special/gnome-copied-files'];

/** Há arquivo (ou URI de arquivo) neste drop/paste? Texto puro (só text/plain) não conta. */
export function hasAttachment(types: readonly string[] | undefined): boolean {
  if (!types) return false;
  return FILE_TYPES.some((t) => types.includes(t));
}

/** O mínimo que planAttach lê de um DataTransfer (dá para fingir nos testes). */
export interface TransferLike {
  types: readonly string[];
  getData(type: string): string;
  /** Quantos arquivos com bytes (DataTransfer.files.length). */
  fileCount: number;
}

export type AttachPlan =
  | { kind: 'paths'; paths: string[] } // caminhos file:// prontos (sem upload)
  | { kind: 'upload' } // subir os bytes de dt.files
  | { kind: 'hint'; message: string } // nada dá para resolver (recent:// sem bytes)
  | { kind: 'none' }; // não é anexo: deixa o comportamento padrão (colar texto etc.)

/** Linhas de uma lista de URIs (text/uri-list / x-special/gnome-copied-files), sem comentários nem vazias. */
function uriLines(raw: string, dropFirst: boolean): string[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  // x-special/gnome-copied-files começa com "copy"/"cut" na 1ª linha.
  return dropFirst ? lines.slice(1) : lines;
}

/** file:///home/a%20b.pdf -> /home/a b.pdf. Devolve undefined se não for um file:// com caminho absoluto. */
export function pathFromFileUri(uri: string): string | undefined {
  if (!/^file:\/\//i.test(uri)) return undefined;
  let rest = uri.slice('file://'.length);
  // file://host/caminho (raro) -> começa depois do host; file:///caminho -> já começa em "/".
  if (rest && !rest.startsWith('/')) {
    const slash = rest.indexOf('/');
    if (slash < 0) return undefined;
    rest = rest.slice(slash);
  }
  try {
    const decoded = decodeURIComponent(rest);
    return decoded.startsWith('/') ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Decide o que fazer com um drop/paste, sem tocar em rede nem em bytes. */
export function planAttach(t: TransferLike): AttachPlan {
  const types = t.types ?? [];
  // Prefere a lista do GNOME (traz o caminho real mesmo quando o uri-list vem com recent://).
  const gnome = types.includes('x-special/gnome-copied-files') ? uriLines(t.getData('x-special/gnome-copied-files'), true) : [];
  const uriList = types.includes('text/uri-list') ? uriLines(t.getData('text/uri-list'), false) : [];
  const uris = [...gnome, ...uriList];

  const paths: string[] = [];
  const unresolved: string[] = [];
  for (const u of uris) {
    const p = pathFromFileUri(u);
    if (p) {
      if (!paths.includes(p)) paths.push(p);
    } else if (!unresolved.includes(u)) unresolved.push(u);
  }

  if (paths.length) return { kind: 'paths', paths };
  if (t.fileCount > 0) return { kind: 'upload' }; // imagem colada, arrastar só-bytes, ou recent:// que trouxe os bytes
  if (unresolved.length) {
    return {
      kind: 'hint',
      message: tr('Não consegui pegar o arquivo da área de transferência (recent://). Arraste o arquivo para cá, ou copie-o pela pasta real no gerenciador de arquivos.'),
    };
  }
  return { kind: 'none' };
}

/** Caminho para inserir no prompt: entre aspas simples se tiver espaço ou aspas (como o shell e o Claude Code esperam). */
export function formatPathForInsert(path: string): string {
  if (!/[\s'"]/.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/** Lê os bytes de um Blob/File como base64 puro (sem o prefixo data:). */
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read'));
    reader.onload = () => {
      const s = typeof reader.result === 'string' ? reader.result : '';
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : '');
    };
    reader.readAsDataURL(blob);
  });
}

let nextShotId = 1;

/** Nome de arquivo para uma imagem colada sem nome (ex.: print da tela). */
function blobName(file: File | Blob, index: number): string {
  const named = (file as File).name;
  if (named) return named;
  const ext = (file.type.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
  return `anexo-${Date.now()}-${nextShotId++ + index}.${ext}`;
}

/** Sobe um arquivo para o servidor e devolve o caminho absoluto onde foi gravado. */
export async function uploadFile(file: File | Blob, name: string): Promise<string> {
  const data = await toBase64(file);
  const res = await fetch('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type: file.type || 'application/octet-stream', data }),
  });
  const j = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok || !j.path) throw new Error(j.error ?? tr('erro {0}', [res.status]));
  return j.path;
}

export interface AttachResult {
  /** Caminhos absolutos a inserir no prompt (direto ou já gravados). */
  paths: string[];
  /** Aviso humano quando algo não pôde ser resolvido (ex.: recent://, arquivo grande demais). */
  hint?: string;
}

/**
 * Resolve um drop/paste em caminhos absolutos: usa file:// direto, ou sobe os bytes de dt.files. `files` é
 * DataTransfer.files (já em array). Nunca lança: erros viram `hint`.
 */
export async function resolveAttachment(t: TransferLike, files: ReadonlyArray<File | Blob>): Promise<AttachResult> {
  const plan = planAttach(t);
  if (plan.kind === 'none') return { paths: [] };
  if (plan.kind === 'hint') return { paths: [], hint: plan.message };
  if (plan.kind === 'paths') return { paths: plan.paths };

  const paths: string[] = [];
  const problems: string[] = [];
  let index = 0;
  for (const file of files) {
    const name = blobName(file, index++);
    if (file.size > UPLOAD_MAX_BYTES) {
      problems.push(tr('{0} passa de {1} MB', [name, Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)]));
      continue;
    }
    try {
      paths.push(await uploadFile(file, name));
    } catch (err) {
      problems.push(tr('{0}: {1}', [name, err instanceof Error ? err.message : String(err)]));
    }
  }
  const out: AttachResult = { paths };
  if (problems.length) out.hint = tr('Não consegui anexar: {0}', [problems.join('; ')]);
  return out;
}
