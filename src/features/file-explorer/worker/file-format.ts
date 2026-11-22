import type { FileViewFormat } from './types';
import { hasZipMagic } from './zip-archive-view';

export async function inspectFileFormat({ bytes, size, partial }: {
  bytes: Uint8Array<ArrayBuffer>, size: number | undefined, partial: boolean,
}): Promise<FileViewFormat> {
  if (bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === 0x46554747) {
    return { kind: 'model', extension: 'gguf' };
  }
  if (size !== undefined && bytes.length >= 9 && bytes[8] === 0x7b) {
    const headerSize = new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(0, true);
    if (headerSize >= 2n && headerSize <= BigInt(size - 8)) {
      // The model reader validates the header and its tensor offsets before displaying metadata.
      return { kind: 'model', extension: 'safetensors' };
    }
  }

  let detected: { ext: string, mime: string } | undefined;
  if (bytes.length >= 4) {
    try {
      const { fileTypeFromBuffer } = await import('file-type');
      detected = await fileTypeFromBuffer(bytes);
    } catch {
      // A finite sample may end before the format-specific probe does.
    }
  }
  if (hasZipMagic({ bytes })) {
    return { kind: 'archive', extension: detected?.ext ?? 'zip', mimeType: detected?.mime ?? 'application/zip' };
  }
  if (detected) {
    const category = detected.mime.split('/')[0];
    switch (category) {
    case 'image': case 'audio': case 'video':
      return { kind: category, extension: detected.ext, mimeType: detected.mime };
    default:
      return { kind: 'binary', extension: detected.ext, mimeType: detected.mime };
    }
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: partial });
    const hasControl = bytes.some(byte => byte <= 8 || byte === 11 || (byte >= 14 && byte < 32) || byte === 127);
    if (!hasControl && (text.length > 0 || !partial)) {
      return { kind: 'text' };
    }
  } catch {
    // An invalid UTF-8 sample can still be inspected as bytes.
  }
  return { kind: 'binary' };
}

export const TEST_ONLY = {
};
