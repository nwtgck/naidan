import type { FileExplorerEntry } from './types';
import { getFileExtension } from './utils';

export type DelimitedFormat = 'csv' | 'tsv';
export type FileViewKind = 'text' | 'markdown' | 'delimited' | 'patch' | 'model' | 'audio' | 'video' | 'image' | 'binary';

export const DELIMITED_PREVIEW_BYTES = 64 * 1024;
export const BINARY_PREVIEW_BYTES = 1024;

const mediaMimeTypes: ReadonlyMap<string, string> = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp'],
  ['.gif', 'image/gif'], ['.avif', 'image/avif'], ['.bmp', 'image/bmp'], ['.ico', 'image/x-icon'],
  ['.tiff', 'image/tiff'], ['.tif', 'image/tiff'],
  ['.wav', 'audio/wav'], ['.mp3', 'audio/mpeg'], ['.flac', 'audio/flac'], ['.aac', 'audio/aac'],
  ['.m4a', 'audio/mp4'], ['.oga', 'audio/ogg'], ['.opus', 'audio/ogg'],
  ['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.ogg', 'video/ogg'], ['.ogv', 'video/ogg'],
  ['.mov', 'video/quicktime'], ['.avi', 'video/x-msvideo'], ['.mkv', 'video/x-matroska'],
]);

export function getFileViewMediaType({ kind, blobType, extension }: { kind: 'image' | 'audio' | 'video', blobType: string, extension: string }): string {
  if (blobType.startsWith(`${kind}/`)) {
    return blobType;
  }
  const inferred = mediaMimeTypes.get(extension);
  return inferred?.startsWith(`${kind}/`) ? inferred : '';
}

export function getFileViewImageExtensions({ mimeType }: { mimeType: string }): readonly [string, ...string[]] | undefined {
  switch (mimeType) {
  case 'image/jpeg': return ['.jpg', '.jpeg'];
  case 'image/webp': return ['.webp'];
  case 'image/png': return ['.png'];
  default: return undefined;
  }
}

export function withFileViewExtension({ name, extension }: { name: string, extension: string }): string {
  const previous = getFileExtension({ name });
  const stem = name.slice(0, name.length - previous.length);
  return stem + extension;
}

export function getDelimitedFormat({ extension }: { extension: string }): DelimitedFormat | undefined {
  switch (extension) {
  case '.csv': return 'csv';
  case '.tsv': return 'tsv';
  default: return undefined;
  }
}

export function getFileViewKind({ entry }: { entry: FileExplorerEntry }): FileViewKind {
  switch (entry.extension) {
  case '.md': case '.markdown': return 'markdown';
  case '.csv': case '.tsv': return 'delimited';
  case '.diff': case '.patch': return 'patch';
  case '.gguf': case '.safetensors': return 'model';
  default: return entry.mimeCategory;
  }
}

export function getFileViewParentPath({ path }: { path: string }): string {
  const parent = path.slice(0, path.lastIndexOf('/'));
  return parent || '/';
}

export function isFileViewPathWithin({ path, directoryPath }: { path: string, directoryPath: string }): boolean {
  return directoryPath === '/' || path === directoryPath || path.startsWith(`${directoryPath}/`);
}

export function decodeFileViewText({ bytes }: { bytes: ArrayBuffer }) {
  let raw: string;
  let valid = true;
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    valid = false;
  }
  const bom = raw.startsWith('\uFEFF');
  const withoutBOM = bom ? raw.slice(1) : raw;
  const withoutCRLF = withoutBOM.replaceAll('\r\n', '');
  const usesCRLF = withoutCRLF.length !== withoutBOM.length;
  const mixed = withoutCRLF.includes('\r') || (usesCRLF && withoutCRLF.includes('\n'));
  return {
    raw,
    editorText: withoutBOM.replaceAll('\r\n', '\n').replaceAll('\r', '\n'),
    bom,
    usesCRLF,
    editable: valid && !mixed,
  };
}

export function formatFileViewText({ text, bom, usesCRLF }: { text: string, bom: boolean, usesCRLF: boolean }): string {
  return (bom ? '\uFEFF' : '') + (usesCRLF ? text.replaceAll('\n', '\r\n') : text);
}

export function getFileViewSaveTarget({ path }: { path: string }): { kind: 'create', directoryPath: string, name: string } | undefined {
  if (!path.startsWith('/')) {
    return undefined;
  }
  const segments = path.slice(1).split('/');
  const name = segments.pop();
  if (name === undefined || [name, ...segments].some(segment => !segment || segment === '.' || segment === '..' || /[\\\0]/.test(segment))) {
    return undefined;
  }
  return { kind: 'create', directoryPath: segments.length ? `/${segments.join('/')}` : '/', name };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
