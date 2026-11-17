/**
 * Copied from vivid-workers src/utils/image-dimensions.ts.
 * Read image pixel dimensions from the file header without fully decoding the
 * bitmap. This is the safety net that catches cases where the user uploaded a
 * file under the byte cap (e.g. 1.2 MB JPEG) but with very high pixel count
 * (e.g. 17 MP) — the kind of input that crashes Photon-WASM during the resize
 * step on Cloudflare Workers (CPU/memory exhaustion in the WASM heap, which
 * is uncatchable from JS and leaves the job stuck in `processing`).
 *
 * Supports JPEG, PNG, WebP. Returns null on unrecognized formats — the caller
 * should not block the upload in that case (let the existing byte cap apply).
 */

export interface ImageDimensions {
  width: number;
  height: number;
  format: 'jpeg' | 'png' | 'webp';
}

export function readImageDimensions(buffer: ArrayBuffer): ImageDimensions | null {
  const view = new DataView(buffer);
  if (view.byteLength < 16) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A, then IHDR chunk at offset 16 with width/height
  if (
    view.getUint8(0) === 0x89 &&
    view.getUint8(1) === 0x50 &&
    view.getUint8(2) === 0x4e &&
    view.getUint8(3) === 0x47
  ) {
    if (view.byteLength < 24) return null;
    return {
      width: view.getUint32(16, false),
      height: view.getUint32(20, false),
      format: 'png',
    };
  }

  // JPEG: FF D8, then walk segments (SOFn marker carries dimensions)
  if (view.getUint8(0) === 0xff && view.getUint8(1) === 0xd8) {
    let offset = 2;
    while (offset < view.byteLength - 1) {
      if (view.getUint8(offset) !== 0xff) return null;
      let marker = view.getUint8(offset + 1);
      // Skip filler bytes (0xFF padding between segments)
      while (marker === 0xff && offset + 2 < view.byteLength) {
        offset++;
        marker = view.getUint8(offset + 1);
      }
      offset += 2;
      // SOI / EOI / RSTn have no length, but we shouldn't see them mid-walk.
      if (marker === 0xd8 || marker === 0xd9) return null;
      // SOFn markers (Start Of Frame) — 0xC0..0xCF except 0xC4, 0xC8, 0xCC
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        // SOF payload: length(2) + precision(1) + height(2) + width(2)
        if (offset + 7 > view.byteLength) return null;
        const height = view.getUint16(offset + 3, false);
        const width = view.getUint16(offset + 5, false);
        return { width, height, format: 'jpeg' };
      }
      // Generic segment with length prefix
      if (offset + 2 > view.byteLength) return null;
      const segLen = view.getUint16(offset, false);
      if (segLen < 2) return null;
      offset += segLen;
    }
    return null;
  }

  // WebP: "RIFF" .. "WEBP" .. variant chunk ("VP8 " / "VP8L" / "VP8X")
  if (
    view.getUint8(0) === 0x52 && // R
    view.getUint8(1) === 0x49 && // I
    view.getUint8(2) === 0x46 && // F
    view.getUint8(3) === 0x46 && // F
    view.byteLength >= 30 &&
    view.getUint8(8) === 0x57 && // W
    view.getUint8(9) === 0x45 && // E
    view.getUint8(10) === 0x42 && // B
    view.getUint8(11) === 0x50 // P
  ) {
    const variant =
      String.fromCharCode(view.getUint8(12)) +
      String.fromCharCode(view.getUint8(13)) +
      String.fromCharCode(view.getUint8(14)) +
      String.fromCharCode(view.getUint8(15));
    if (variant === 'VP8 ') {
      // Lossy: width/height at offset 26/28 (14 bits each, little-endian)
      const w = view.getUint16(26, true) & 0x3fff;
      const h = view.getUint16(28, true) & 0x3fff;
      return { width: w, height: h, format: 'webp' };
    }
    if (variant === 'VP8L') {
      // Lossless: 14-bit width-1 / height-1 packed at offset 21..24
      const b0 = view.getUint8(21);
      const b1 = view.getUint8(22);
      const b2 = view.getUint8(23);
      const b3 = view.getUint8(24);
      const w = 1 + (((b1 & 0x3f) << 8) | b0);
      const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width: w, height: h, format: 'webp' };
    }
    if (variant === 'VP8X') {
      // Extended: 24-bit width-1 / height-1 at offset 24..29 (LE)
      if (view.byteLength < 30) return null;
      const w = 1 + (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16));
      const h = 1 + (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16));
      return { width: w, height: h, format: 'webp' };
    }
  }

  return null;
}
