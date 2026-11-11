// Decorações procedurais em pixel art. Mesma escala dos móveis do escritório.
import { PixelBuf } from './core/pixbuf';
import type { BufSprite } from './core/sprite';

export type SeasonalProp = 'tree' | 'gift' | 'pumpkin' | 'ghost' | 'wreath' | 'bat' | 'orb' | 'shelf' | 'crystal';

// Paleta do tema Frinus "A Mente".
const FRINUS = {
  roxo: '#6C3FC4',
  roxo600: '#5A32A8',
  roxoClaro: '#7a52d2',
  lavanda: '#EFE9FB',
  wash: '#F7F4FD',
  ink: '#1A1A2E',
  ink2: '#2b2442',
  ambar: '#E8B860',
  ambarClaro: '#F3D694',
} as const;

export function renderSeasonalProp(kind: SeasonalProp): BufSprite {
  const b = new PixelBuf(40, 64);
  const rect = (x: number, y: number, w: number, h: number, c: string) => b.rect(x, y, w, h, c);
  if (kind === 'tree') {
    b.shadow(20, 59, 17, 3, '#252c39', 0.22);
    rect(17, 49, 6, 9, '#80573d');
    for (let row = 0; row < 4; row++) {
      const y = 13 + row * 8;
      const half = 6 + row * 3;
      rect(20 - half, y, half * 2 + 1, 9, '#245644');
      rect(22 - half, y, half * 2 - 4, 6, '#387956');
      rect(22 - half, y + 1, half - 1, 3, '#4d9361');
    }
    b.vline(20, 5, 13, '#ffe0a0');
    b.hline(16, 24, 9, '#ffe0a0');
    rect(18, 7, 5, 5, '#ffc45d');
    for (const [x, y] of [[16, 20], [24, 24], [13, 31], [25, 36], [9, 42], [20, 43], [31, 44]]) {
      rect(x, y, 3, 3, '#e05250');
      b.set(x, y, '#ffb27b');
    }
    for (const [x, y] of [[21, 17], [15, 26], [23, 30], [15, 38], [26, 42], [11, 47]]) {
      rect(x, y, 2, 2, '#ffe8b2');
    }
    rect(3, 52, 10, 8, '#a82d42');
    rect(6, 51, 2, 9, '#e5c17b');
    rect(3, 54, 10, 1, '#e5c17b');
    rect(26, 51, 10, 9, '#e6b357');
    rect(30, 50, 2, 10, '#b33549');
    rect(26, 54, 10, 1, '#b33549');
  } else if (kind === 'gift') {
    b.shadow(20, 59, 9, 2, '#252c39', 0.2);
    rect(11, 49, 17, 11, '#bf3849');
    rect(11, 49, 17, 3, '#e35a58');
    rect(18, 49, 3, 11, '#efd1a0');
    rect(11, 54, 17, 2, '#efd1a0');
    rect(14, 46, 5, 3, '#e8b860');
    rect(21, 46, 5, 3, '#e8b860');
  } else if (kind === 'pumpkin') {
    b.shadow(20, 59, 11, 2, '#252c39', 0.2);
    rect(18, 41, 3, 6, '#557342');
    rect(11, 46, 18, 14, '#c56832');
    rect(8, 49, 24, 8, '#e18b39');
    rect(13, 46, 4, 13, '#f0a647');
    rect(23, 47, 3, 12, '#f0a647');
    rect(12, 50, 4, 3, '#523347');
    rect(24, 50, 4, 3, '#523347');
    rect(17, 56, 7, 2, '#523347');
    b.set(13, 51, '#ffd680');
    b.set(25, 51, '#ffd680');
    b.hline(18, 22, 56, '#ffd680');
  } else if (kind === 'ghost') {
    rect(15, 39, 10, 3, '#e0dae9');
    rect(12, 42, 16, 15, '#e0dae9');
    rect(14, 41, 11, 15, '#fff4ed');
    rect(10, 47, 4, 4, '#e0dae9');
    rect(26, 47, 4, 4, '#e0dae9');
    for (const x of [12, 18, 24]) rect(x, 56, 4, 3, '#e0dae9');
    rect(16, 46, 2, 3, '#574563');
    rect(23, 46, 2, 3, '#574563');
    rect(19, 51, 3, 2, '#574563');
  } else if (kind === 'wreath') {
    rect(12, 39, 16, 4, '#347653');
    rect(10, 43, 5, 10, '#245644');
    rect(25, 43, 5, 10, '#347653');
    rect(13, 53, 15, 4, '#245644');
    for (const [x, y] of [[14, 41], [26, 47], [12, 50], [23, 54]]) rect(x, y, 2, 2, '#e45c58');
    rect(15, 55, 4, 4, '#c93945');
    rect(21, 55, 4, 4, '#c93945');
    rect(19, 54, 2, 4, '#f07368');
  } else if (kind === 'bat') {
    rect(18, 51, 5, 6, '#47344f');
    rect(10, 50, 9, 4, '#47344f');
    rect(22, 50, 9, 4, '#47344f');
    rect(7, 48, 4, 4, '#47344f');
    rect(30, 48, 4, 4, '#47344f');
    rect(13, 53, 3, 3, '#47344f');
    rect(25, 53, 3, 3, '#47344f');
    b.set(19, 52, '#f5b95f');
    b.set(21, 52, '#f5b95f');
  } else if (kind === 'orb') {
    // Placa/orbe Frinus da recepção: esfera roxa sobre pedestal, com o símbolo do infinito em âmbar.
    b.shadow(20, 58, 9, 2, '#252c39', 0.22);
    rect(15, 52, 11, 6, FRINUS.ink2); // pedestal
    rect(16, 51, 9, 1, '#3a3160');
    rect(14, 57, 13, 2, FRINUS.ink);
    rect(18, 46, 5, 6, '#4a2f86'); // haste
    b.ellipse(20, 33, 11, 11, FRINUS.roxo600); // esfera (sombra)
    b.ellipse(19, 32, 9, 9, FRINUS.roxo); // lado iluminado
    b.ellipse(16, 29, 2, 2, FRINUS.lavanda); // brilho
    b.set(15, 28, FRINUS.wash);
    // Infinito em âmbar (8 deitado) centrado em (20,34).
    const inf: Array<[number, number]> = [
      [-4, -1], [-3, -1], [-5, 0], [-2, 0], [-4, 1], [-3, 1],
      [-1, 0], [0, 0], [1, 0],
      [3, -1], [4, -1], [2, 0], [5, 0], [3, 1], [4, 1],
    ];
    for (const [dx, dy] of inf) b.set(20 + dx, 34 + dy, FRINUS.ambar);
  } else if (kind === 'shelf') {
    // Estante de "memórias": lombadas roxas e uma âmbar por prateleira.
    b.shadow(20, 58, 12, 2, '#252c39', 0.22);
    rect(8, 13, 25, 45, FRINUS.ink2); // corpo
    rect(8, 13, 25, 2, '#3b3360'); // topo
    rect(8, 56, 25, 2, '#1b1730'); // base
    rect(8, 13, 2, 45, '#201b35'); // montante esq.
    rect(31, 13, 2, 45, '#201b35'); // montante dir.
    const shades = [FRINUS.roxo, FRINUS.roxo600, FRINUS.roxoClaro, FRINUS.roxo600, FRINUS.roxo, FRINUS.ambar];
    for (const ry of [17, 30, 43]) {
      rect(10, ry + 11, 21, 2, '#15111d'); // tábua
      let x = 11;
      let i = ry % 3;
      while (x <= 29) {
        const sw = 2 + ((x + ry) % 2); // 2 ou 3 px
        if (x + sw > 30) break;
        const c = shades[i % shades.length];
        rect(x, ry + 1, sw, 10, c);
        b.hline(x, x + sw - 1, ry + 1, c === FRINUS.ambar ? FRINUS.ambarClaro : '#cdbbf0'); // topo das lombadas
        x += sw + 1;
        i++;
      }
    }
  } else {
    // crystal — cristal de memória roxo sobre base, com um brilho âmbar no núcleo.
    b.shadow(20, 58, 7, 2, '#252c39', 0.2);
    rect(15, 54, 11, 4, FRINUS.ink2); // base
    rect(14, 57, 13, 1, FRINUS.ink);
    const cx = 20, top = 32, bot = 54, mid = 41, maxW = 7;
    for (let yy = top; yy <= bot; yy++) {
      const w = yy <= mid ? Math.round((maxW * (yy - top)) / (mid - top)) : Math.round((maxW * (bot - yy)) / (bot - mid));
      if (w <= 0) continue;
      rect(cx - w, yy, 2 * w + 1, 1, FRINUS.roxo); // corpo
      rect(cx + 1, yy, w, 1, FRINUS.roxo600); // faceta escura (direita)
      b.set(cx - w, yy, FRINUS.roxoClaro); // aresta iluminada (esquerda)
    }
    b.line(cx - 1, 35, cx - 4, 47, FRINUS.lavanda); // faceta de brilho
    b.set(cx, 30, FRINUS.lavanda); // ápice
    b.set(cx - 1, 43, FRINUS.ambar); // núcleo de memória
    b.set(cx, 44, FRINUS.ambarClaro);
  }
  b.outline();
  return { buf: b, ax: 20, ay: 60 };
}
