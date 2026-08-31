/** 256-entry RGBA colormaps for scalar coloring, uploaded as 256×1 textures. */

export type ColormapName = 'viridis' | 'rainbow' | 'grayscale' | 'classification';

export const CONTINUOUS_MAPS: ColormapName[] = ['viridis', 'rainbow', 'grayscale'];

// matplotlib viridis sampled at t = 0, 0.1, …, 1.0.
const VIRIDIS: [number, number, number][] = [
  [0.267, 0.005, 0.329],
  [0.283, 0.141, 0.458],
  [0.254, 0.265, 0.53],
  [0.207, 0.372, 0.553],
  [0.164, 0.471, 0.558],
  [0.128, 0.567, 0.551],
  [0.135, 0.659, 0.518],
  [0.267, 0.749, 0.441],
  [0.478, 0.821, 0.318],
  [0.741, 0.873, 0.15],
  [0.993, 0.906, 0.144],
];

const RAINBOW: [number, number, number][] = [
  [0.18, 0.19, 0.57],
  [0.06, 0.35, 0.85],
  [0.05, 0.62, 0.87],
  [0.1, 0.8, 0.64],
  [0.45, 0.91, 0.31],
  [0.83, 0.93, 0.19],
  [0.99, 0.79, 0.13],
  [0.98, 0.55, 0.11],
  [0.93, 0.29, 0.13],
  [0.79, 0.1, 0.19],
  [0.62, 0.04, 0.26],
];

function fromStops(stops: [number, number, number][]): Uint8Array {
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const lo = Math.min(Math.floor(t), stops.length - 2);
    const f = t - lo;
    for (let c = 0; c < 3; c++)
      out[i * 4 + c] = Math.round(255 * (stops[lo][c] * (1 - f) + stops[lo + 1][c] * f));
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** ASPRS-style class colors; unknown classes get a stable hashed hue. */
function classificationPalette(): Uint8Array {
  const known: Record<number, [number, number, number]> = {
    0: [140, 140, 140], // never classified
    1: [180, 180, 180], // unclassified
    2: [161, 120, 74], // ground
    3: [154, 205, 108], // low vegetation
    4: [98, 181, 80], // medium vegetation
    5: [46, 137, 55], // high vegetation
    6: [214, 71, 63], // building
    7: [227, 135, 245], // low noise
    8: [255, 190, 90], // reserved / model key
    9: [66, 132, 237], // water
    10: [255, 220, 90], // rail
    11: [90, 90, 100], // road surface
    13: [230, 200, 60], // wire guard
    14: [250, 170, 40], // wire conductor
    15: [200, 130, 30], // transmission tower
    17: [120, 160, 200], // bridge deck
    18: [250, 100, 220], // high noise
  };
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    let rgb = known[i];
    if (!rgb) {
      const hue = (i * 137.508) % 360; // golden-angle spread
      rgb = hslToRgb(hue / 360, 0.55, 0.55);
    }
    out.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  }
  return out;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}

const cache = new Map<ColormapName, Uint8Array>();

export function colormapData(name: ColormapName): Uint8Array {
  let data = cache.get(name);
  if (!data) {
    switch (name) {
      case 'viridis':
        data = fromStops(VIRIDIS);
        break;
      case 'rainbow':
        data = fromStops(RAINBOW);
        break;
      case 'grayscale':
        data = fromStops([
          [0.08, 0.08, 0.09],
          [0.95, 0.95, 0.96],
        ]);
        break;
      case 'classification':
        data = classificationPalette();
        break;
    }
    cache.set(name, data);
  }
  return data;
}
