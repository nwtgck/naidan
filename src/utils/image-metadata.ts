/**
 * Unique symbol for unsupported format to ensure type safety.
 * Following user request: 'unsupported' should be unique symbol.
 */
export const UNSUPPORTED: unique symbol = Symbol('unsupported');

/**
 * Supported image formats for metadata embedding.
 * Adding a new format here will trigger exhaustive check errors in switches throughout the codebase.
 */
export type SupportedFormat = 'png' | 'webp';

/**
 * Result of format detection.
 */
export type ImageFormat = SupportedFormat | typeof UNSUPPORTED;

/**
 * Metadata structure for image embedding.
 */
export interface ImageMetadata {
  prompt: string | undefined;
  model: string | undefined;
  steps: number | undefined;
  seed: number | undefined;
}

/**
 * Detects image format based on file signatures.
 * Exported to allow manual switching at the call site.
 */
export async function detectFormat({ blob }: { blob: Blob }): Promise<ImageFormat> {
  const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
  const bytes = new Uint8Array(arrayBuffer);

  // PNG Signature: 0x89 0x50 0x4E 0x47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return 'png';
  }
  // WebP Signature: RIFF .... WEBP
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50    // WEBP
  ) {
    return 'webp';
  }
  return UNSUPPORTED;
}

/**
 * Embeds metadata into PNG using multiple tEXt chunks.
 */
export async function embedMetadataInPng({ blob, metadata }: {
  blob: Blob,
  metadata: ImageMetadata
}): Promise<Blob> {
  const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
  const bytes = new Uint8Array(arrayBuffer);

  const metadataToEmbed = [
    { key: 'prompt', value: metadata.prompt },
    { key: 'model', value: metadata.model },
    { key: 'steps', value: metadata.steps?.toString() },
    { key: 'seed', value: metadata.seed?.toString() },
  ].filter((item): item is { key: string, value: string } => !!item.value);

  let currentBytes = bytes;

  for (const { key, value } of metadataToEmbed) {
    const chunk = createPngTextChunk({ key, value });

    // Insert after IHDR (Offset 33)
    const nextBytes = new Uint8Array(currentBytes.length + chunk.length);
    nextBytes.set(currentBytes.slice(0, 33), 0);
    nextBytes.set(chunk, 33);
    nextBytes.set(currentBytes.slice(33), 33 + chunk.length);
    currentBytes = nextBytes;
  }

  return new Blob([currentBytes as BlobPart], { type: 'image/png' });
}

/**
 * Embeds metadata into WebP using an XMP chunk.
 */
export async function embedMetadataInWebp({ blob, metadata }: {
  blob: Blob,
  metadata: ImageMetadata
}): Promise<Blob> {
  const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
  const bytes = new Uint8Array(arrayBuffer);

  const xmpData = `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:naidan="naidan.invalid">
   <dc:description>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${metadata.prompt || ''}</rdf:li>
    </rdf:Alt>
   </dc:description>
   <xmp:CreatorTool>${metadata.model || ''}</xmp:CreatorTool>
   <naidan:steps>${metadata.steps !== undefined ? metadata.steps : ''}</naidan:steps>
   <naidan:seed>${metadata.seed !== undefined ? metadata.seed : ''}</naidan:seed>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

  const textEncoder = new TextEncoder();
  const xmpBytes = textEncoder.encode(xmpData);
  const chunkType = textEncoder.encode('XMP ');
  const chunkLength = xmpBytes.length;

  const padding = chunkLength % 2 === 1 ? 1 : 0;
  const chunk = new Uint8Array(4 + 4 + chunkLength + padding);
  const view = new DataView(chunk.buffer);

  chunk.set(chunkType, 0);
  view.setUint32(4, chunkLength, true);
  chunk.set(xmpBytes, 8);
  if (padding) chunk[8 + chunkLength] = 0;

  const newRiffSize = bytes.length + chunk.length - 8;
  const result = new Uint8Array(bytes.length + chunk.length);
  result.set(bytes, 0);
  result.set(chunk, bytes.length);

  const resultView = new DataView(result.buffer);
  resultView.setUint32(4, newRiffSize, true);

  return new Blob([result as BlobPart], { type: 'image/webp' });
}

/**
 * Creates a single PNG tEXt chunk for a key-value pair.
 */
function createPngTextChunk({ key, value }: { key: string, value: string }): Uint8Array {
  const textEncoder = new TextEncoder();
  const content = textEncoder.encode(`${key}\0${value}`);
  const type = textEncoder.encode('tEXt');

  const chunk = new Uint8Array(4 + 4 + content.length + 4);
  const view = new DataView(chunk.buffer);

  view.setUint32(0, content.length);
  chunk.set(type, 4);
  chunk.set(content, 8);

  const crc = computeCrc32({ data: chunk.slice(4, 4 + 4 + content.length) });
  view.setUint32(4 + 4 + content.length, crc);

  return chunk;
}

/**
 * Computes CRC-32 for PNG chunks.
 */
function computeCrc32({ data }: { data: Uint8Array }): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (byte === undefined) continue;
    crc ^= byte;
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xedb88320;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
