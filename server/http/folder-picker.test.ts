import { describe, expect, it } from 'vitest';
import { parseGraphicalEnv, pickerCommand } from './folder-picker';

const env = (o: Partial<Parameters<typeof pickerCommand>[1]>) => ({ platform: 'linux' as NodeJS.Platform, wsl: false, has: () => false, graphical: true, ...o });

describe('pickerCommand', () => {
  it('Linux usa zenity quando existe, com a pasta inicial', () => {
    const c = pickerCommand('/home/x/Frinus', env({ has: (b) => b === 'zenity' }));
    expect(c?.file).toBe('zenity');
    expect(c?.args).toContain('--directory');
    expect(c?.args).toContain('--filename=/home/x/Frinus/');
  });
  it('Linux cai para kdialog', () => {
    expect(pickerCommand('/h', env({ has: (b) => b === 'kdialog' }))?.file).toBe('kdialog');
  });
  it('sem sessão gráfica ou sem ferramenta: indisponível', () => {
    expect(pickerCommand('/h', env({ graphical: false, has: () => true }))).toBeNull();
    expect(pickerCommand('/h', env({}))).toBeNull();
  });
  it('macOS usa osascript e passa o caminho como argumento (sem interpolar no script)', () => {
    const c = pickerCommand('/Users/a"b', env({ platform: 'darwin' }));
    expect(c?.file).toBe('osascript');
    expect(c?.args[1]).not.toContain('a"b');
    expect(c?.args.at(-1)).toBe('/Users/a"b');
  });
  it('WSL usa o PowerShell do Windows e converte o caminho', () => {
    const c = pickerCommand('/home/x', env({ wsl: true }));
    expect(c?.file).toBe('powershell.exe');
    expect(c?.post).toBeTypeOf('function');
  });
  it('Windows escapa aspas simples do caminho inicial', () => {
    const c = pickerCommand("C:\\O'Brien", env({ platform: 'win32' }));
    expect(c?.args.at(-1)).toContain("'C:\\O''Brien'");
  });
});

describe('parseGraphicalEnv', () => {
  it('pega só as variáveis gráficas do systemctl --user show-environment', () => {
    const out = 'HOME=/home/x\nDISPLAY=:0\nWAYLAND_DISPLAY=wayland-0\nXAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.ABC\nPATH=/usr/bin\n';
    expect(parseGraphicalEnv(out)).toEqual({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XAUTHORITY: '/run/user/1000/.mutter-Xwaylandauth.ABC' });
  });
  it('saída vazia ou sem sessão gráfica: nada', () => {
    expect(parseGraphicalEnv('')).toEqual({});
    expect(parseGraphicalEnv('HOME=/h\nLANG=pt_BR.UTF-8')).toEqual({});
  });
});
