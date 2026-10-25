// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadSharpEncoder, unavailableEncoder } from "./sharpEncoder";

describe("the vehicle's sharp frame encoder", () => {
  const red = (w: number, h: number, bgr: boolean) => {
    const data = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) data[i * 3 + (bgr ? 2 : 0)] = 255; // pure red either way
    return { kind: "raw" as const, width: w, height: h, channels: 3 as const, bgr, data, encoding: bgr ? "bgr8" : "rgb8" };
  };

  it("downscales raw pixels to max_width and encodes JPEG, swapping bgr", async () => {
    const enc = await loadSharpEncoder();
    const out = await enc.encode(red(640, 480, true), { maxWidth: 320, quality: 60, format: "jpeg" });
    expect([out.width, out.height, out.mime]).toEqual([320, 240, "image/jpeg"]);
    expect([...out.bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    // Decoding it back: a red frame stays red (the swap happened).
    const sharp = (await import("sharp")).default;
    const { data } = await sharp(out.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200);
    expect(data[2]).toBeLessThan(60);
  });

  it("never enlarges, encodes WebP, and re-encodes compressed sources with their size", async () => {
    const enc = await loadSharpEncoder();
    const small = await enc.encode(red(100, 50, false), { maxWidth: 640, quality: 50, format: "webp" });
    expect([small.width, small.height, small.mime]).toEqual([100, 50, "image/webp"]);
    const jpeg = await enc.encode(red(800, 600, false), { maxWidth: 1920, quality: 90, format: "jpeg" });
    const again = await enc.encode({ kind: "compressed", format: "jpeg", data: jpeg.bytes }, { maxWidth: 400, quality: 40, format: "jpeg" });
    expect([again.width, again.height, again.sourceWidth, again.sourceHeight]).toEqual([400, 300, 800, 600]);
    expect(again.bytes.length).toBeLessThan(jpeg.bytes.length);
  });

  it("says why when frames are unavailable", async () => {
    await expect(unavailableEncoder("sharp is not installed").encode(red(1, 1, false), { maxWidth: 64, quality: 50, format: "jpeg" }))
      .rejects.toThrow(/image frames unavailable on this vehicle \(sharp is not installed\)/);
    await expect(loadSharpEncoder("sharp-does-not-exist")).rejects.toThrow();
  });
});
