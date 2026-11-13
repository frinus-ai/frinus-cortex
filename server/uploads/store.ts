// Upload de arquivos arrastados ou colados no terminal e na caixa de mensagem (POST /api/uploads). O navegador não
// revela o caminho de um arquivo arrastado/colado nem os bytes de um `recent://`, então a página manda os bytes em
// base64 e o servidor os grava no computador, em ~/Frinus/anexos/<AAAA-MM-DD>/, devolvendo o caminho absoluto. Esse
// caminho é o que entra no prompt (é assim que o Claude Code anexa arquivos e imagens). Quando o navegador JÁ conhece
// o caminho local (um `file://` do gerenciador de arquivos), a página usa o caminho direto e NÃO chama esta rota.
// Node puro e sem dependências, como spawn/attachments.ts (de onde vem a sanitização de nome).
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tr } from '../../shared/i18n';
import { safeFileName } from '../spawn/attachments';

/** Teto por arquivo (imagens de tela e PDFs cabem com folga; o que passa disso é recusado). */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** Corpo de POST /api/uploads: o arquivo em base64 (4/3) e folga para o JSON. */
export const UPLOAD_BODY_MAX = Math.ceil((UPLOAD_MAX_BYTES * 4) / 3) + 64 * 1024;

export interface Upload {
  name: string;
  type: string;
  data: Buffer;
}

/** Confere o corpo de POST /api/uploads: {name, type?, data (base64)}. Mesma forma de spawn/attachments.parseAttachment. */
export function parseUpload(raw: unknown): Upload | { error: string } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const name = typeof r.name === 'string' ? safeFileName(r.name) : 'arquivo';
  const type = typeof r.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(r.type) ? r.type : 'application/octet-stream';
  if (typeof r.data !== 'string' || !r.data) return { error: tr('arquivo vazio') };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(r.data)) return { error: tr('arquivo ilegível (base64)') };
  const data = Buffer.from(r.data, 'base64');
  if (!data.length) return { error: tr('arquivo vazio') };
  if (data.length > UPLOAD_MAX_BYTES) return { error: tr('o arquivo passa de {0} MB', [UPLOAD_MAX_BYTES / 1024 / 1024]) };
  return { name, type, data };
}

/** Pasta raiz dos anexos: ~/Frinus/anexos (sobrescreva com FRINUS_ANEXOS_DIR). */
export function uploadsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.FRINUS_ANEXOS_DIR?.trim() || join(env.HOME || homedir(), 'Frinus', 'anexos');
}

function dayStamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

/**
 * Grava o arquivo numa pasta do dia (700; arquivo 600), com nome seguro e único (sem sobrescrever nada). Devolve o
 * caminho absoluto. Node puro: pode ser chamado direto nos testes.
 */
export function saveUpload(root: string, file: Upload, at = new Date(), newId: () => string = randomUUID): string {
  const dir = join(root, dayStamp(at));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // pasta herdada de outra data: mantém o modo que já tem
  }
  let name = safeFileName(file.name);
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  // wx: nunca sobrescreve; em colisão, acrescenta um sufixo curto e tenta de novo.
  for (let tries = 0; ; tries++) {
    const path = join(dir, name);
    try {
      writeFileSync(path, file.data, { mode: 0o600, flag: 'wx' });
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || tries > 50) throw err;
      name = `${stem}-${newId().replace(/[^a-z0-9]/gi, '').slice(0, 6) || tries + 1}${ext}`;
    }
  }
}
