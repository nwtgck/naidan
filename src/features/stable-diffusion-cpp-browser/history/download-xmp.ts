/** XMP stores the same complete JSON snapshot as PNG iTXt, as RDF text. */
export function generationXmp({ json }: { json: string }): Uint8Array<ArrayBuffer> {
  // JSON escapes control characters. Escape the two remaining non-XML Unicode
  // characters inside JSON strings so parsing the JSON recovers them unchanged.
  const safeJson = json.replaceAll('\ufffe', '\\ufffe').replaceAll('\uffff', '\\uffff');
  const text = safeJson.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return new TextEncoder().encode(`<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:naidan="https://naidan.app/ns/image-generation/1.0/"><naidan:Generation>${text}</naidan:Generation></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`);
}

const jpegXmpIdentifier = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0');

/** Standard JPEG APP1 XMP only; ExtendedXMP is intentionally unsupported.
 * https://developer.adobe.com/xmp/docs/xmp-specifications/ (Part 3)
 */
export function jpegWithXmp({ bytes, packet }: { bytes: Uint8Array<ArrayBuffer>, packet: Uint8Array<ArrayBuffer> }): Blob {
  // Adobe's standard packet bound also leaves room for the identifier and the
  // 16-bit segment length. Large settings must use PNG or WebP without loss.
  if (packet.length > 65_502) throw new Error('Generation settings are too large for JPEG metadata. Choose PNG or WebP.');
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Invalid JPEG header');
  let insertion = 2;
  let reachedImage = false;
  for (let offset = 2; offset < bytes.length;) {
    const markerStart = offset;
    if (bytes[offset++] !== 0xff) throw new Error('Invalid JPEG segment');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) {
      reachedImage = true;
      break; // Entropy-coded scan bytes must never be parsed as metadata.
    }
    if (marker === undefined || marker === 0 || marker === 0xd8 || marker === 1 || marker >= 0xd0 && marker <= 0xd7 || offset + 2 > bytes.length) throw new Error('Invalid JPEG marker');
    const size = bytes[offset]! * 256 + bytes[offset + 1]!;
    if (size < 2 || offset + size > bytes.length) throw new Error('Truncated JPEG segment');
    const payload = bytes.subarray(offset + 2, offset + size);
    if (marker === 0xe1 && jpegXmpIdentifier.every((value, index) => payload[index] === value)) {
      throw new Error('The encoded JPEG unexpectedly contains existing XMP metadata');
    }
    // Keep JFIF/Exif ahead of our APP1 packet. No image segments are rewritten.
    if (markerStart === insertion && (marker === 0xe0 || marker === 0xe1)) insertion = offset + size;
    offset += size;
  }
  if (!reachedImage || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error('Incomplete JPEG image');
  const segment = new Uint8Array(4 + jpegXmpIdentifier.length + packet.length);
  segment.set([0xff, 0xe1]);
  new DataView(segment.buffer).setUint16(2, segment.length - 2);
  segment.set(jpegXmpIdentifier, 4);
  segment.set(packet, 4 + jpegXmpIdentifier.length);
  return new Blob([bytes.subarray(0, insertion), segment, bytes.subarray(insertion)], { type: 'image/jpeg' });
}

function riffChunk({ name, payload }: { name: string, payload: Uint8Array<ArrayBuffer> }): Uint8Array<ArrayBuffer> {
  const chunk = new Uint8Array(8 + payload.length + payload.length % 2);
  chunk.set(new TextEncoder().encode(name));
  new DataView(chunk.buffer).setUint32(4, payload.length, true);
  chunk.set(payload, 8);
  return chunk;
}

/** Preserve encoded image/alpha data, adding the extended-header metadata flag.
 * https://developers.google.com/speed/webp/docs/riff_container
 */
export function webpWithXmp({ bytes, packet }: { bytes: Uint8Array<ArrayBuffer>, packet: Uint8Array<ArrayBuffer> }): Blob {
  const text = new TextDecoder();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || text.decode(bytes.subarray(0, 4)) !== 'RIFF' || text.decode(bytes.subarray(8, 12)) !== 'WEBP' || view.getUint32(4, true) !== bytes.length - 8) throw new Error('Invalid WebP container');
  const chunks: { name: string, bytes: Uint8Array<ArrayBuffer>, payload: Uint8Array<ArrayBuffer> }[] = [];
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error('Truncated WebP chunk');
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size;
    const paddedEnd = end + size % 2;
    if (paddedEnd > bytes.length || size % 2 && bytes[end] !== 0) throw new Error('Invalid WebP chunk padding');
    chunks.push({ name: text.decode(bytes.subarray(offset, offset + 4)), bytes: bytes.subarray(offset, paddedEnd), payload: bytes.subarray(offset + 8, end) });
    offset = paddedEnd;
  }
  if (chunks.some(chunk => chunk.name === 'XMP ')) throw new Error('The encoded WebP unexpectedly contains existing XMP metadata');
  const extended = chunks.find(chunk => chunk.name === 'VP8X');
  let header: Uint8Array<ArrayBuffer>;
  if (extended) {
    if (chunks[0] !== extended || extended.payload.length !== 10 || chunks.filter(chunk => chunk.name === 'VP8X').length !== 1) throw new Error('Invalid WebP extended header');
    header = extended.payload.slice();
  } else {
    // Canvas may emit simple lossy or lossless WebP. Their bitstream headers
    // carry the original dimensions and (for VP8L) whether alpha is used.
    if (chunks.length !== 1) throw new Error('Invalid simple WebP image');
    const image = chunks[0];
    if (!image) throw new Error('WebP image data is missing');
    const data = image.payload;
    let width: number;
    let height: number;
    let alpha = false;
    if (image.name === 'VP8 ' && data.length >= 10 && !(data[0]! & 1) && data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
      width = (data[6]! | data[7]! << 8) & 0x3fff;
      height = (data[8]! | data[9]! << 8) & 0x3fff;
    } else if (image.name === 'VP8L' && data.length >= 5 && data[0] === 0x2f && !(data[4]! & 0xe0)) {
      const bits = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, true);
      width = (bits & 0x3fff) + 1;
      height = (bits >>> 14 & 0x3fff) + 1;
      alpha = !!(bits & 0x10000000);
    } else throw new Error('Unsupported WebP image header');
    if (!width || !height) throw new Error('Invalid WebP dimensions');
    header = new Uint8Array(10);
    header[0] = alpha ? 0x10 : 0;
    for (let byte = 0; byte < 3; byte++) {
      header[4 + byte] = (width - 1) >>> (byte * 8) & 0xff;
      header[7 + byte] = (height - 1) >>> (byte * 8) & 0xff;
    }
  }
  header[0] = header[0]! | 0x04;
  const headerChunk = riffChunk({ name: 'VP8X', payload: header });
  const xmp = riffChunk({ name: 'XMP ', payload: packet });
  const body = chunks.filter(chunk => chunk !== extended).map(chunk => chunk.bytes);
  const total = 12 + headerChunk.length + body.reduce((sum, chunk) => sum + chunk.length, 0) + xmp.length;
  if (total > 0xfffffffe) throw new Error('WebP metadata exceeds the container size limit');
  const riff = bytes.slice(0, 12);
  new DataView(riff.buffer).setUint32(4, total - 8, true);
  return new Blob([riff, headerChunk, ...body, xmp], { type: 'image/webp' });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
