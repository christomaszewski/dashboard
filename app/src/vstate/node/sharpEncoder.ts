// Frame encoding on the vehicle with sharp (libvips): downscale, then JPEG or WebP. Loaded at runtime
// by specifier, never bundled: deploy/Dockerfile.state installs the version app/package.json pins next
// to the bundle. Without it, frames answer with an error and everything else keeps working.
import type { EncodedFrame, FrameEncoder, FrameSource } from "../frames";

// The few sharp calls used here, typed locally (sharp's own types need @types/node).
interface SharpImage {
  recomb(matrix: number[][]): SharpImage;
  removeAlpha(): SharpImage;
  resize(opts: { width: number; withoutEnlargement: boolean }): SharpImage;
  jpeg(opts: { quality: number; mozjpeg: boolean }): SharpImage;
  webp(opts: { quality: number; effort: number }): SharpImage;
  metadata(): Promise<{ width?: number; height?: number }>;
  toBuffer(opts: { resolveWithObject: true }): Promise<{ data: Uint8Array; info: { width: number; height: number } }>;
}
type Sharp = (input: Uint8Array, opts?: { raw?: { width: number; height: number; channels: 1 | 3 | 4 }; failOn?: string }) => SharpImage;

export async function loadSharpEncoder(specifier = "sharp"): Promise<FrameEncoder> {
  const mod = (await import(/* @vite-ignore */ specifier)) as { default?: Sharp } & Sharp;
  const sharp: Sharp = mod.default ?? mod;
  return {
    async encode(src: FrameSource, { maxWidth, quality, format }): Promise<EncodedFrame> {
      let img = src.kind === "raw"
        ? sharp(src.data, { raw: { width: src.width, height: src.height, channels: src.channels } })
        : sharp(src.data, { failOn: "none" });
      if (src.kind === "raw" && src.bgr) img = img.recomb([[0, 0, 1], [0, 1, 0], [1, 0, 0]]);
      if (src.kind === "raw" && src.channels === 4 && format === "jpeg") img = img.removeAlpha();
      img = img.resize({ width: maxWidth, withoutEnlargement: true });
      img = format === "webp" ? img.webp({ quality, effort: 2 }) : img.jpeg({ quality, mozjpeg: false });
      const [{ data, info }, meta] = await Promise.all([
        img.toBuffer({ resolveWithObject: true }),
        src.kind === "compressed" ? sharp(src.data, { failOn: "none" }).metadata() : Promise.resolve(undefined),
      ]);
      return {
        bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        width: info.width,
        height: info.height,
        mime: format === "webp" ? "image/webp" : "image/jpeg",
        sourceWidth: meta?.width,
        sourceHeight: meta?.height,
      };
    },
  };
}

/** Used when sharp is missing: frames say why instead of the service failing to start. */
export function unavailableEncoder(reason: string): FrameEncoder {
  return { encode: () => Promise.reject(new Error(`image frames unavailable on this vehicle (${reason})`)) };
}
