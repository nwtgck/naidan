/** A resource guard, not an image decoder. Inspect dimensions before passing
 * untrusted compressed bytes to the browser/native decoder. Animated images
 * and unsupported JPEG frame types are deliberately not peer capabilities.
 * PNG: https://www.w3.org/TR/png-3/#11IHDR
 * WebP: https://developers.google.com/speed/webp/docs/riff_container */
export function peerImageDimensions({ bytes, mimeType }: {
  bytes: Uint8Array; mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = (): never => {
    throw new Error('Unsupported or malformed remote image');
  };
  const size = ({ width, height }: { width: number; height: number }) => {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 4 * 1024 * 1024) throw new Error('Remote image pixel limit exceeded');
    return { width, height };
  };
  const text = ({ offset }: { offset: number }) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  switch (mimeType) {
  case 'image/png': {
    if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => value === bytes[index]) || view.getUint32(8) !== 13 || text({ offset: 12 }) !== 'IHDR') return invalid();
    const dimensions = size({ width: view.getUint32(16), height: view.getUint32(20) });
    // Validate chunk boundaries too; do not let an animation bypass the bound
    // with additional frames or silently accept a truncated compressed image.
    let image = false;
    for (let offset = 33; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset), kind = text({ offset: offset + 4 });
      if (length > bytes.length - offset - 12 || kind === 'acTL' || kind === 'fcTL' || kind === 'fdAT' || kind === 'IHDR') return invalid();
      if (kind === 'IDAT') image = true;
      if (kind === 'IEND') {
        if (!image || length !== 0 || offset + 12 !== bytes.length) return invalid();
        return dimensions;
      }
      offset += length + 12;
    }
    return invalid();
  }
  case 'image/jpeg': {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return invalid();
    let dimensions: { width: number; height: number } | undefined;
    let inScan = false, sawScan = false;
    const components = new Set<number>();
    for (let offset = 2; offset < bytes.length;) {
      // Entropy bytes are not decoded here. Recognize byte stuffing and restart
      // markers, then resume structural validation at the next actual marker.
      // Progressive JPEG has several scans: returning at the first SOS would
      // leave later frame headers, DNL and malformed segment lengths unchecked.
      if (inScan && bytes[offset] !== 0xff) {
        offset++; continue;
      }
      if (bytes[offset++] !== 0xff) return invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === undefined) return invalid();
      if (inScan && (marker === 0 || marker >= 0xd0 && marker <= 0xd7)) continue;
      inScan = false;
      if (marker === 0xd9) return sawScan && dimensions && offset === bytes.length ? dimensions : invalid();
      if (marker === 0 || marker === 1 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7 ||
        marker === 0xdc || marker === 0xde || marker === 0xdf || offset + 2 > bytes.length) return invalid();
      const length = view.getUint16(offset);
      if (length < 2 || length > bytes.length - offset) return invalid();
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (![0xc0, 0xc1, 0xc2].includes(marker) || dimensions || length < 8 || bytes[offset + 2] !== 8) return invalid();
        const count = bytes[offset + 7]!;
        if (count < 1 || count > 4 || length !== 8 + 3 * count) return invalid();
        for (let at = offset + 8; at < offset + length; at += 3) {
          const id = bytes[at]!, sampling = bytes[at + 1]!;
          if (components.has(id) || sampling >> 4 < 1 || sampling >> 4 > 4 || (sampling & 15) < 1 || (sampling & 15) > 4) return invalid();
          components.add(id);
        }
        dimensions = size({ height: view.getUint16(offset + 3), width: view.getUint16(offset + 5) });
      }
      if (marker === 0xda) {
        if (!dimensions || length < 6) return invalid();
        const count = bytes[offset + 2]!;
        if (count < 1 || count > components.size || length !== 6 + 2 * count) return invalid();
        const selected = new Set<number>();
        for (let at = offset + 3; at < offset + 3 + 2 * count; at += 2) {
          const id = bytes[at]!;
          if (!components.has(id) || selected.has(id)) return invalid();
          selected.add(id);
        }
        inScan = true; sawScan = true;
      }
      offset += length;
    }
    return invalid();
  }
  case 'image/webp': {
    if (bytes.length < 20 || text({ offset: 0 }) !== 'RIFF' || text({ offset: 8 }) !== 'WEBP' || view.getUint32(4, true) !== bytes.length - 8) return invalid();
    let canvas: { width: number; height: number } | undefined;
    let image: { width: number; height: number } | undefined;
    for (let offset = 12; offset < bytes.length;) {
      if (offset + 8 > bytes.length) return invalid();
      const length = view.getUint32(offset + 4, true), kind = text({ offset });
      const start = offset + 8, end = start + length, padded = end + length % 2;
      if (padded > bytes.length || length % 2 && bytes[end] !== 0) return invalid();
      const data = bytes.subarray(start, end);
      if (kind === 'ANIM' || kind === 'ANMF') return invalid();
      if (kind === 'VP8X') {
        if (offset !== 12 || length !== 10 || data[0]! & 2) return invalid();
        canvas = size({ width: 1 + data[4]! + (data[5]! << 8) + (data[6]! << 16), height: 1 + data[7]! + (data[8]! << 8) + (data[9]! << 16) });
      } else if (kind === 'VP8 ') {
        if (image || length < 10 || data[0]! & 1 || data[3] !== 0x9d || data[4] !== 1 || data[5] !== 0x2a) return invalid();
        image = size({ width: (data[6]! | data[7]! << 8) & 0x3fff, height: (data[8]! | data[9]! << 8) & 0x3fff });
      } else if (kind === 'VP8L') {
        if (image || length < 5 || data[0] !== 0x2f || data[4]! & 0xe0) return invalid();
        const bits = view.getUint32(start + 1, true);
        image = size({ width: (bits & 0x3fff) + 1, height: (bits >>> 14 & 0x3fff) + 1 });
      }
      offset = padded;
    }
    if (!image || canvas && (canvas.width !== image.width || canvas.height !== image.height)) return invalid();
    return image;
  }
  default: { const exhaustive: never = mimeType; throw new Error(String(exhaustive)); }
  }
}
export const TEST_ONLY = {
};
