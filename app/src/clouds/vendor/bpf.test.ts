import { describe, expect, it } from 'vitest';
import { parseBpf } from './loaders/bpf';
// @ts-expect-error plain-JS test helper, outside tsc's include
import { writeBpfV1, writeBpfV3 } from './bpfWrite.mjs';

const N = 1000;

/** Deterministic pseudo-random test cloud on a ~100 m UTM tile. */
function testDims() {
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const x = new Float32Array(N);
  const y = new Float32Array(N);
  const z = new Float32Array(N);
  const intensity = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    x[i] = rand() * 100;
    y[i] = rand() * 100;
    z[i] = rand() * 30;
    intensity[i] = Math.floor(rand() * 256);
  }
  return [
    { label: 'X', offset: 500000, values: x },
    { label: 'Y', offset: 4400000, values: y },
    { label: 'Z', offset: 120, values: z },
    { label: 'Intensity', offset: 0, values: intensity },
  ];
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function expectMatchesSource(data: ReturnType<typeof parseBpf>, dims = testDims()) {
  expect(data.count).toBe(N);
  const [dx, dy, dz, di] = dims;
  for (const i of [0, 1, 17, N - 1]) {
    // Absolute coordinate = origin + local position; compare against offset + raw.
    expect(data.origin[0] + data.positions[i * 3]).toBeCloseTo(dx.offset + dx.values[i], 4);
    expect(data.origin[1] + data.positions[i * 3 + 1]).toBeCloseTo(dy.offset + dy.values[i], 4);
    expect(data.origin[2] + data.positions[i * 3 + 2]).toBeCloseTo(dz.offset + dz.values[i], 4);
  }
  expect(data.attributes).toHaveLength(1);
  const attr = data.attributes[0];
  expect(attr.name).toBe('Intensity');
  for (const i of [0, 5, N - 1]) expect(attr.values[i]).toBe(di.values[i]);
  expect(attr.min).toBeGreaterThanOrEqual(0);
  expect(attr.max).toBeLessThanOrEqual(255);
  expect(data.crs).toBe('UTM zone 18N (WGS84)');
}

describe('BPF v3', () => {
  it('parses dim-major uncompressed', () => {
    const data = parseBpf(toBuffer(writeBpfV3({ dims: testDims(), interleave: 0 })));
    expectMatchesSource(data);
    expect(data.source.version).toBe(3);
  });

  it('parses point-major', () => {
    expectMatchesSource(parseBpf(toBuffer(writeBpfV3({ dims: testDims(), interleave: 1 }))));
  });

  it('parses byte-major', () => {
    expectMatchesSource(parseBpf(toBuffer(writeBpfV3({ dims: testDims(), interleave: 2 }))));
  });

  it('parses zlib compression across multiple blocks', () => {
    // 1000 pts × 4 dims × 4 B = 16 kB; 4 kB blocks force 4 blocks.
    const bytes = writeBpfV3({ dims: testDims(), interleave: 0, compress: true, blockBytes: 4096 });
    const data = parseBpf(toBuffer(bytes));
    expectMatchesSource(data);
    expect(data.source.compression).toBe(3);
  });

  it('applies the header transform matrix', () => {
    const dims = testDims();
    const xform = [1, 0, 0, 10, 0, 1, 0, -20, 0, 0, 1, 5, 0, 0, 0, 1]; // translate (10, -20, 5)
    const data = parseBpf(toBuffer(writeBpfV3({ dims, interleave: 0, xform })));
    const [dx] = dims;
    expect(data.origin[0] + data.positions[0]).toBeCloseTo(dx.offset + dx.values[0] + 10, 4);
    expect(data.origin[2] + data.positions[2]).toBeCloseTo(dims[2].offset + dims[2].values[0] + 5, 4);
  });

  it('preserves local coordinate precision on large UTM offsets', () => {
    const data = parseBpf(toBuffer(writeBpfV3({ dims: testDims(), interleave: 0 })));
    // Local spread should be ~tile-sized, not offset-sized.
    const { min, max } = data.localBounds;
    expect(max[0] - min[0]).toBeLessThan(200);
    expect(Math.abs(min[0] + max[0])).toBeLessThan(200); // roughly centered on origin
    expect(data.origin[0]).toBeGreaterThan(499000);
  });

  it('rejects truncated files', () => {
    const bytes = writeBpfV3({ dims: testDims(), interleave: 0 });
    expect(() => parseBpf(toBuffer(bytes.subarray(0, bytes.length - 100)))).toThrow(/truncated/);
  });

  it('rejects non-BPF data', () => {
    expect(() => parseBpf(new ArrayBuffer(64))).toThrow(/not a BPF file/);
  });
});

describe('BPF v1/v2 (legacy)', () => {
  it('parses a v1 dim-major file', () => {
    const data = parseBpf(toBuffer(writeBpfV1({ dims: testDims(), version: 1 })));
    expectMatchesSource(data);
    expect(data.source.version).toBe(1);
  });

  it('parses a v2 point-major file', () => {
    const data = parseBpf(toBuffer(writeBpfV1({ dims: testDims(), version: 2 })));
    expectMatchesSource(data);
    expect(data.source.version).toBe(2);
  });
});
