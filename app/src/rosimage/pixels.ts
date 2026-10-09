/** Convert decoded sensor_msgs/Image pixels; no ROS, DOM, or canvas dependencies. */
export const MAX_IMAGE_PIXELS = 2_097_152;
export const MAX_IMAGE_BYTES = 16_777_216;
const formats = new Map([
  ["mono8", { channels: 1, bytes: 1 }], ["8UC1", { channels: 1, bytes: 1 }],
  ["mono16", { channels: 1, bytes: 2 }], ["16UC1", { channels: 1, bytes: 2 }],
  ["rgb8", { channels: 3, bytes: 1 }], ["bgr8", { channels: 3, bytes: 1 }],
  ["rgba8", { channels: 4, bytes: 1 }], ["bgra8", { channels: 4, bytes: 1 }],
]);

export interface ImagePixels {
  width: number;
  height: number;
  encoding: string;
  rgba: Uint8ClampedArray;
}

export function imagePixels(message: Record<string, unknown>, normalize: boolean): ImagePixels {
  const { width, height, step, encoding, is_bigendian: big } = message;
  const format = typeof encoding === "string" ? formats.get(encoding) : undefined;
  if (!format) throw new Error(`Unsupported image encoding: ${String(encoding)}`);
  if (typeof width !== "number" || typeof height !== "number" || !Number.isInteger(width) || !Number.isInteger(height) ||
    width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > MAX_IMAGE_PIXELS) {
    throw new Error("Invalid or oversized image dimensions (limit: 2 megapixels)");
  }
  const pixelBytes = format.channels * format.bytes;
  if (typeof step !== "number" || !Number.isInteger(step) || step < width * pixelBytes || step * height > MAX_IMAGE_BYTES) {
    throw new Error("Invalid or oversized image row stride (limit: 16 MiB)");
  }
  if (big !== 0 && big !== 1 && big !== false && big !== true) throw new Error("Invalid image byte order");
  let data: Uint8Array | Uint8ClampedArray;
  const raw = message.data;
  if (raw instanceof Uint8Array || raw instanceof Uint8ClampedArray) data = raw;
  else if (Array.isArray(raw) && raw.length <= MAX_IMAGE_BYTES && raw.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) data = Uint8Array.from(raw);
  else throw new Error("Invalid image byte array");
  if (data.byteLength < step * height || data.byteLength > MAX_IMAGE_BYTES) throw new Error("Truncated or oversized image data");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const mono = (offset: number) => format.bytes === 2 ? view.getUint16(offset, !big) : data[offset];
  let low = 0, high = format.bytes === 2 ? 65535 : 255;
  if (normalize && format.channels === 1) {
    let min = Infinity, max = -Infinity;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const value = mono(y * step + x * pixelBytes);
      min = Math.min(min, value); max = Math.max(max, value);
    }
    // Constant frames retain their full-range brightness instead of dividing by zero.
    if (max > min) { low = min; high = max; }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  const bgr = encoding === "bgr8" || encoding === "bgra8";
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const src = y * step + x * pixelBytes, dst = (y * width + x) * 4;
    if (format.channels === 1) {
      const value = Math.round((mono(src) - low) * 255 / (high - low));
      rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = value;
    } else {
      rgba[dst] = data[src + (bgr ? 2 : 0)]; rgba[dst + 1] = data[src + 1]; rgba[dst + 2] = data[src + (bgr ? 0 : 2)];
    }
    rgba[dst + 3] = format.channels === 4 ? data[src + 3] : 255;
  }
  return { width, height, encoding: encoding as string, rgba };
}
