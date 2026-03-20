import { fileTypeFromBuffer } from 'file-type';
import type { WeshCommandContext } from '@/services/wesh/types';
import { readFile } from '@/services/wesh/utils/fs';
import type { FileCommandClassification, FileCommandTargetInfo } from './types';

function resolvePath({
  cwd,
  path,
}: {
  cwd: string;
  path: string;
}): string {
  return path.startsWith('/') ? path : `${cwd}/${path}`;
}

function isAsciiText({
  bytes,
}: {
  bytes: Uint8Array;
}): boolean {
  for (const byte of bytes) {
    if (byte === 9 || byte === 10 || byte === 13) {
      continue;
    }
    if (byte < 32 || byte > 126) {
      return false;
    }
  }
  return true;
}

function isLikelyBinary({
  bytes,
}: {
  bytes: Uint8Array;
}): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

function decodeUtf8({
  bytes,
}: {
  bytes: Uint8Array;
}): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function decodeUtf16({
  bytes,
}: {
  bytes: Uint8Array;
}): string | undefined {
  if (bytes.length < 2) {
    return undefined;
  }
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
    try {
      return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    } catch {
      return undefined;
    }
  }
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
    const swapped = new Uint8Array(bytes.length - 2);
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1] ?? 0;
      swapped[index - 1] = bytes[index] ?? 0;
    }
    try {
      return new TextDecoder('utf-16le', { fatal: true }).decode(swapped);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function classifyText({
  bytes,
}: {
  bytes: Uint8Array;
}): FileCommandClassification {
  const text = decodeUtf8({ bytes });
  if (text === undefined) {
    const utf16 = decodeUtf16({ bytes });
    if (utf16 !== undefined) {
      return { kind: 'utf16-text' };
    }
    return { kind: 'data' };
  }

  const normalizedText = text.replace(/^\uFEFF/, '');
  const trimmed = normalizedText.trimStart();

  if (trimmed.startsWith('#!') && /(?:^|\W)(?:sh|bash|dash|ksh|zsh)(?:\W|$)/.test(trimmed)) {
    return { kind: 'shell-script' };
  }

  try {
    JSON.parse(normalizedText);
    return { kind: 'json' };
  } catch {
    // ignore
  }

  if (trimmed.startsWith('<svg') || trimmed.startsWith('<?xml') && trimmed.toLowerCase().includes('<svg')) {
    return { kind: 'svg' };
  }
  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<root') || trimmed.startsWith('<note') || trimmed.startsWith('<rss')) {
    return { kind: 'xml' };
  }
  if (trimmed.toLowerCase().startsWith('<!doctype html') || trimmed.toLowerCase().startsWith('<html')) {
    return { kind: 'html' };
  }
  if (isAsciiText({ bytes })) {
    return { kind: 'ascii-text' };
  }
  return { kind: 'utf8-text' };
}

export async function statFileTarget({
  context,
  path,
}: {
  context: WeshCommandContext;
  path: string;
}): Promise<FileCommandTargetInfo> {
  const resolvedPath = resolvePath({
    cwd: context.cwd,
    path,
  });
  const lstat = await context.files.lstat({ path: resolvedPath });
  switch (lstat.type) {
  case 'symlink': {
    const target = await context.files.readlink({ path: resolvedPath });
    return {
      displayPath: path,
      resolvedPath,
      fileType: lstat.type,
      size: lstat.size,
      symlinkTarget: target,
    };
  }
  case 'file':
  case 'directory':
  case 'fifo':
  case 'chardev':
    return {
      displayPath: path,
      resolvedPath,
      fileType: lstat.type,
      size: lstat.size,
      symlinkTarget: undefined,
    };
  default: {
    const _ex: never = lstat.type;
    throw new Error(`Unhandled file type: ${_ex}`);
  }
  }
}

export async function detectFileClassification({
  context,
  target,
}: {
  context: WeshCommandContext;
  target: FileCommandTargetInfo;
}): Promise<FileCommandClassification> {
  switch (target.fileType) {
  case 'directory':
    return { kind: 'directory' };
  case 'fifo':
    return { kind: 'fifo' };
  case 'symlink':
    return { kind: 'symlink', target: target.symlinkTarget ?? '' };
  case 'chardev':
    return { kind: 'data' };
  case 'file':
    break;
  default: {
    const _ex: never = target.fileType;
    throw new Error(`Unhandled stat file type: ${_ex}`);
  }
  }

  if (target.size === 0) {
    return { kind: 'empty' };
  }

  const bytes = await readFile({
    files: context.files,
    path: target.resolvedPath,
  });

  if (decodeUtf16({ bytes }) !== undefined) {
    return { kind: 'utf16-text' };
  }

  const detected = await fileTypeFromBuffer(bytes);
  if (detected !== undefined) {
    return { kind: 'binary', detected };
  }

  if (isLikelyBinary({ bytes })) {
    return { kind: 'data' };
  }

  return classifyText({ bytes });
}
