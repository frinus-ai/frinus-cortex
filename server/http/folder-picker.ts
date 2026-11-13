// Seletor de pasta NATIVO do sistema operacional para a janela "Nova conversa com o Frinus".
//
// O navegador não entrega o caminho absoluto de uma pasta (showDirectoryPicker só devolve um handle), mas o
// servidor do escritório roda no próprio computador do usuário, na sessão gráfica dele. Então quem abre o
// diálogo é o servidor: zenity/kdialog no Linux, osascript no macOS e PowerShell (FolderBrowserDialog) no
// Windows/WSL. Tudo via execFile, sem shell; o caminho inicial vai como argumento, nunca interpolado em código.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Resultado: caminho escolhido, cancelado pelo usuário, ou sem seletor disponível nesta máquina. */
export type PickResult = { kind: 'picked'; path: string } | { kind: 'cancelled' } | { kind: 'unavailable' };

interface PickerCommand {
  file: string;
  args: string[];
  /** Pós-processa a saída (ex.: WSL converte C:\... para /mnt/c/...). */
  post?: (out: string) => Promise<string>;
}

/** O usuário tem até 10 min para escolher; depois o diálogo é encerrado. */
const PICK_TIMEOUT_MS = 10 * 60_000;

function run(file: string, args: string[], timeout = PICK_TIMEOUT_MS): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : -1) : 0;
      done({ code, out: String(stdout ?? '') });
    });
  });
}

function onPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && existsSync(resolve(dir, bin))) return true;
  }
  return false;
}

function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** Escapa uma string para um literal entre aspas simples do PowerShell. */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

const PROMPT = 'Escolha a pasta da conversa com o Frinus';

/** Monta o comando do seletor para esta plataforma (ou null quando não há nenhum). Exportado para teste. */
export function pickerCommand(startDir: string, env: { platform: NodeJS.Platform; wsl: boolean; has: (bin: string) => boolean; graphical: boolean }): PickerCommand | null {
  if (env.platform === 'darwin') {
    const script = [
      'on run argv',
      `  set p to POSIX path of (choose folder with prompt "${PROMPT}" default location (POSIX file (item 1 of argv)))`,
      '  return p',
      'end run',
    ].join('\n');
    return { file: 'osascript', args: ['-e', script, startDir] };
  }
  if (env.platform === 'win32' || env.wsl) {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
      `$d.Description = ${psQuote(PROMPT)};`,
      '$d.ShowNewFolderButton = $true;',
      env.platform === 'win32' ? `$d.SelectedPath = ${psQuote(startDir)};` : '',
      "$f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true};",
      'if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath); exit 0 } else { exit 1 }',
    ].join(' ');
    const post = env.wsl
      ? async (out: string) => {
          const r = await run('wslpath', ['-u', out.trim()], 10_000);
          return r.code === 0 ? r.out.trim() : out.trim();
        }
      : undefined;
    return { file: 'powershell.exe', args: ['-NoProfile', '-STA', '-Command', ps], post };
  }
  if (!env.graphical) return null;
  // Linux: prefere o diálogo do próprio desktop.
  if (env.has('zenity')) {
    return { file: 'zenity', args: ['--file-selection', '--directory', `--title=${PROMPT}`, `--filename=${startDir.replace(/\/+$/, '')}/`] };
  }
  if (env.has('kdialog')) return { file: 'kdialog', args: ['--title', PROMPT, '--getexistingdirectory', startDir] };
  if (env.has('yad')) return { file: 'yad', args: ['--file', '--directory', `--title=${PROMPT}`, `--filename=${startDir.replace(/\/+$/, '')}/`] };
  return null;
}

/** Só um diálogo por vez (dois cliques não abrem duas janelas). */
let inFlight: Promise<PickResult> | null = null;

/** Abre o seletor nativo começando em `startDir` (se existir; senão em `home`). */
export function pickFolder(startDir: string | undefined, home: string): Promise<PickResult> {
  if (inFlight) return inFlight;
  const expanded = startDir?.replace(/^~(?=$|\/)/, home);
  const start = expanded && isDir(expanded) ? expanded : home;
  const cmd = pickerCommand(start, {
    platform: process.platform,
    wsl: isWsl(),
    has: onPath,
    graphical: !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
  });
  if (!cmd) return Promise.resolve({ kind: 'unavailable' });
  inFlight = (async (): Promise<PickResult> => {
    const r = await run(cmd.file, cmd.args);
    // 1 = cancelado (zenity/kdialog/PowerShell); osascript cancela com código 1 também.
    if (r.code !== 0) return r.code === 1 ? { kind: 'cancelled' } : { kind: 'unavailable' };
    let path = r.out.replace(/\r?\n$/, '').trim();
    if (cmd.post && path) path = await cmd.post(path);
    if (path.length > 1) path = path.replace(/[\\/]+$/, '');
    return path ? { kind: 'picked', path } : { kind: 'cancelled' };
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
