import { parseBpf } from './bpf';
import { parseLas } from './las';
import type { PointCloudData } from './types';

export type ParseFn = (buffer: ArrayBuffer, name: string) => PointCloudData | Promise<PointCloudData>;

/**
 * Format registry, keyed by lowercase file extension. To add a format, write
 * a parser producing PointCloudData and register it here — the viewer and UI
 * never see format specifics.
 */
const registry = new Map<string, ParseFn>([
  ['bpf', parseBpf],
  ['las', parseLas],
]);

export function supportedExtensions(): string[] {
  return [...registry.keys()];
}

export async function parseFile(name: string, buffer: ArrayBuffer): Promise<PointCloudData> {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const parse = registry.get(ext);
  if (!parse)
    throw new Error(
      `Unsupported format ".${ext}" — supported: ${supportedExtensions()
        .map((e) => '.' + e)
        .join(', ')}`,
    );
  return parse(buffer, name);
}
