import { fileTypeFromBuffer } from 'file-type';
import type { WeshCommandContext, WeshOpenFlags } from '@/features/wesh/types';
import type {
  FileCommandClassification,
  FileCommandLineTerminator,
  FileCommandScriptLanguage,
  FileCommandTargetInfo,
  FileCommandTextDetails,
  FileCommandTextEncoding,
} from './types';

const FILE_SAMPLE_BYTES = 64 * 1024;
const VERY_LONG_LINE_THRESHOLD = 4096;

type DecodedText = {
  text: string,
  encoding: FileCommandTextEncoding,
  hasByteOrderMark: boolean,
};

function resolvePath({
  cwd,
  path,
}: {
  cwd: string,
  path: string,
}): string {
  return path.startsWith('/') ? path : `${cwd}/${path}`;
}

function isAsciiEncoded({
  bytes,
}: {
  bytes: Uint8Array,
}): boolean {
  for (const byte of bytes) {
    if (byte > 0x7F) return false;
  }
  return true;
}

function isAllowedTextCharacter({
  codePoint,
}: {
  codePoint: number,
}): boolean {
  if (codePoint >= 0x20 && codePoint !== 0x7F) return true;
  return codePoint === 0x07
    || codePoint === 0x08
    || codePoint === 0x09
    || codePoint === 0x0A
    || codePoint === 0x0B
    || codePoint === 0x0C
    || codePoint === 0x0D
    || codePoint === 0x1B;
}

function isTextLike({
  text,
}: {
  text: string,
}): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || !isAllowedTextCharacter({ codePoint })) return false;
  }
  return true;
}

function isLikelyBinary({
  bytes,
}: {
  bytes: Uint8Array,
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
  complete,
}: {
  bytes: Uint8Array,
  complete: boolean,
}): DecodedText | undefined {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const text = decoder.decode(bytes, { stream: !complete });
    const hasByteOrderMark = bytes.length >= 3
      && bytes[0] === 0xEF
      && bytes[1] === 0xBB
      && bytes[2] === 0xBF;
    return {
      text,
      encoding: isAsciiEncoded({ bytes }) ? 'us-ascii' : 'utf-8',
      hasByteOrderMark,
    };
  } catch {
    return undefined;
  }
}

function decodeUtf16({
  bytes,
}: {
  bytes: Uint8Array,
}): DecodedText | undefined {
  if (bytes.length < 2) {
    return undefined;
  }
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
    try {
      return {
        text: new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2)),
        encoding: 'utf-16le',
        hasByteOrderMark: true,
      };
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
      return {
        text: new TextDecoder('utf-16le', { fatal: true }).decode(swapped),
        encoding: 'utf-16be',
        hasByteOrderMark: true,
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function decodeText({
  bytes,
  complete,
}: {
  bytes: Uint8Array,
  complete: boolean,
}): DecodedText | undefined {
  return decodeUtf16({ bytes }) ?? decodeUtf8({ bytes, complete });
}

function decodeSingleByteText({
  bytes,
}: {
  bytes: Uint8Array,
}): DecodedText | undefined {
  let hasHighByte = false;
  let hasNonIsoControlByte = false;
  let hasOnlyNextLineControl = true;
  let text = '';
  const chunkCodeUnits: number[] = [];

  const flush = () => {
    if (chunkCodeUnits.length === 0) return;
    text += String.fromCharCode(...chunkCodeUnits);
    chunkCodeUnits.length = 0;
  };

  for (const byte of bytes) {
    if (byte < 0x80) {
      if (!isAllowedTextCharacter({ codePoint: byte })) return undefined;
    } else {
      hasHighByte = true;
      if (byte >= 0x80 && byte <= 0x9F) {
        if (byte !== 0x85) {
          hasNonIsoControlByte = true;
          hasOnlyNextLineControl = false;
        }
      } else {
        hasOnlyNextLineControl = false;
      }
    }

    chunkCodeUnits.push(byte);
    if (chunkCodeUnits.length === 4096) flush();
  }
  flush();

  if (!hasHighByte) return undefined;
  return {
    text,
    encoding: hasOnlyNextLineControl
      ? 'us-ascii'
      : hasNonIsoControlByte
        ? 'unknown-8bit'
        : 'iso-8859-1',
    hasByteOrderMark: false,
  };
}

function buildTextDetails({
  decoded,
}: {
  decoded: DecodedText,
}): FileCommandTextDetails {
  const lines = decoded.text.split(/\r\n|\r|\n/u);
  const longestLineLength = lines.reduce(
    (maximum, line) => Math.max(maximum, line.length),
    0,
  );
  const lineTerminators: FileCommandLineTerminator[] = [];
  if (/\r\n/u.test(decoded.text)) lineTerminators.push('crlf');
  if (/\r(?!\n)/u.test(decoded.text)) lineTerminators.push('cr');
  if (/(^|[^\r])\n/u.test(decoded.text)) lineTerminators.push('lf');
  if (decoded.text.includes('\u0085')) lineTerminators.push('nel');
  return {
    encoding: decoded.encoding,
    hasByteOrderMark: decoded.hasByteOrderMark,
    veryLongLineLength: longestLineLength >= VERY_LONG_LINE_THRESHOLD
      ? longestLineLength
      : undefined,
    lineTerminators,
    hasEscapeSequences: decoded.text.includes('\u001B'),
    hasOverstriking: decoded.text.includes('\b'),
  };
}

function shebangInterpreterName({
  text,
}: {
  text: string,
}): string | undefined {
  if (!text.startsWith('#!')) return undefined;

  const lineEnd = text.search(/[\r\n]/u);
  const line = text.slice(2, lineEnd === -1 ? undefined : lineEnd).trim();
  if (line.length === 0) return undefined;

  const words = line.split(/[\t ]+/u);
  const executable = words[0];
  if (executable === undefined) return undefined;
  const executableName = executable.slice(executable.lastIndexOf('/') + 1);
  if (executableName !== 'env') return executableName;

  const envCommand = words[1];
  if (
    envCommand === undefined
    || envCommand.startsWith('-')
    || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(envCommand)
  ) {
    return undefined;
  }
  return envCommand.slice(envCommand.lastIndexOf('/') + 1);
}

function classifyScriptLanguage({
  text,
}: {
  text: string,
}): FileCommandScriptLanguage | undefined {
  const interpreter = shebangInterpreterName({ text });
  switch (interpreter) {
  case 'sh':
  case 'dash':
  case 'ksh':
  case 'zsh':
    return 'posix_shell';
  case 'bash':
    return 'bash';
  case 'python':
  case 'python2':
  case 'python3':
    return 'python';
  case 'node':
  case 'nodejs':
    return 'node';
  case undefined:
    return undefined;
  default:
    return undefined;
  }
}

function classifyStructuredText({
  decoded,
  complete,
}: {
  decoded: DecodedText,
  complete: boolean,
}): FileCommandClassification | undefined {
  const normalizedText = decoded.text.replace(/^\uFEFF/u, '');
  const normalizedLower = normalizedText.toLowerCase();
  const htmlCandidate = normalizedText.trimStart();
  const htmlCandidateLower = htmlCandidate.toLowerCase();
  const text = buildTextDetails({ decoded });

  if (!isTextLike({ text: normalizedText })) return undefined;

  const scriptLanguage = classifyScriptLanguage({ text: normalizedText });
  if (scriptLanguage !== undefined) {
    return { kind: 'script', language: scriptLanguage, text };
  }

  if (complete) {
    try {
      JSON.parse(normalizedText);
      return { kind: 'json', text };
    } catch {
      // Continue with prefix-based text classification.
    }
  }

  if (
    normalizedLower.startsWith('<svg')
    || normalizedLower.startsWith('<?xml') && normalizedLower.includes('<svg')
  ) {
    return { kind: 'svg', text };
  }
  if (normalizedLower.startsWith('<?xml')) {
    const version = /^<\?xml version=["']([^"']+)["']/u.exec(normalizedText)?.[1];
    return { kind: 'xml', version, text };
  }
  if (htmlCandidateLower.startsWith('<!doctype html') || htmlCandidateLower.startsWith('<html')) {
    return { kind: 'html', text };
  }
  return undefined;
}

async function classifyBytes({
  bytes,
  complete,
  emptySource,
}: {
  bytes: Uint8Array,
  complete: boolean,
  emptySource: 'file' | 'stdin',
}): Promise<FileCommandClassification> {
  if (bytes.length === 0) {
    return { kind: 'empty', source: emptySource };
  }

  const decoded = decodeText({ bytes, complete });
  if (decoded !== undefined) {
    const structured = classifyStructuredText({ decoded, complete });
    if (structured !== undefined) {
      return structured;
    }
  }

  if (decoded?.encoding === 'utf-16le' || decoded?.encoding === 'utf-16be') {
    if (!isTextLike({ text: decoded.text })) return { kind: 'data' };
    return {
      kind: 'utf16_text',
      text: buildTextDetails({ decoded }),
    };
  }

  const detected = await fileTypeFromBuffer(bytes);
  if (detected !== undefined) {
    return { kind: 'binary', detected };
  }

  if (isLikelyBinary({ bytes }) || decoded === undefined) {
    const singleByteText = decodeSingleByteText({ bytes });
    if (singleByteText === undefined) return { kind: 'data' };
    const text = buildTextDetails({ decoded: singleByteText });
    switch (singleByteText.encoding) {
    case 'us-ascii':
      return { kind: 'ascii_text', text };
    case 'iso-8859-1':
    case 'unknown-8bit':
      return { kind: 'extended_ascii_text', text };
    case 'utf-8':
    case 'utf-16le':
    case 'utf-16be':
      throw new Error(`Unexpected single-byte text encoding: ${singleByteText.encoding}`);
    default: {
      const _ex: never = singleByteText.encoding;
      throw new Error(`Unhandled single-byte text encoding: ${_ex}`);
    }
    }
  }

  if (!isTextLike({ text: decoded.text })) return { kind: 'data' };

  const text = buildTextDetails({ decoded });
  switch (decoded.encoding) {
  case 'us-ascii':
    return { kind: 'ascii_text', text };
  case 'utf-8':
    return { kind: 'utf8_text', text };
  case 'iso-8859-1':
  case 'unknown-8bit':
    return { kind: 'extended_ascii_text', text };
  default: {
    const _ex: never = decoded.encoding;
    throw new Error(`Unhandled decoded text encoding: ${_ex}`);
  }
  }
}

async function readFileSample({
  context,
  path,
  size,
}: {
  context: WeshCommandContext,
  path: string,
  size: number,
}): Promise<Uint8Array> {
  const sampleLength = Math.min(size, FILE_SAMPLE_BYTES);
  if (context.files.tryReadBlobEfficiently !== undefined) {
    const blobResult = await context.files.tryReadBlobEfficiently({ path });
    switch (blobResult.kind) {
    case 'blob':
      return new Uint8Array(
        await blobResult.blob.slice(0, sampleLength).arrayBuffer(),
      );
    case 'fallback_required':
      break;
    default: {
      const _ex: never = blobResult;
      throw new Error(`Unhandled blob result: ${JSON.stringify(_ex)}`);
    }
    }
  }

  const flags: WeshOpenFlags = {
    access: 'read',
    creation: 'never',
    truncate: 'preserve',
    append: 'preserve',
  };
  const handle = await context.files.open({ path, flags });
  try {
    const bytes = new Uint8Array(sampleLength);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read({
        buffer: bytes,
        offset,
        length: bytes.byteLength - offset,
      });
      if (result.bytesRead === 0) {
        break;
      }
      offset += result.bytesRead;
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function readStdinSample({
  context,
}: {
  context: WeshCommandContext,
}): Promise<{ bytes: Uint8Array, complete: boolean }> {
  const bytes = new Uint8Array(FILE_SAMPLE_BYTES + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await context.stdin.read({
      buffer: bytes,
      offset,
      length: bytes.byteLength - offset,
    });
    if (result.bytesRead === 0) {
      return { bytes: bytes.subarray(0, offset), complete: true };
    }
    offset += result.bytesRead;
  }
  return {
    bytes: bytes.subarray(0, FILE_SAMPLE_BYTES),
    complete: false,
  };
}

export async function statFileTarget({
  context,
  path,
  followSymlinks,
}: {
  context: WeshCommandContext,
  path: string,
  followSymlinks: boolean,
}): Promise<FileCommandTargetInfo> {
  const resolvedPath = resolvePath({
    cwd: context.cwd,
    path,
  });
  if (followSymlinks) {
    const resolved = await context.files.resolve({ path: resolvedPath });
    return {
      displayPath: path,
      resolvedPath: resolved.fullPath,
      fileType: resolved.stat.type,
      size: resolved.stat.size,
      symlinkTarget: undefined,
      symlinkBroken: false,
    };
  }

  const lstat = await context.files.lstat({ path: resolvedPath });
  switch (lstat.type) {
  case 'symlink': {
    const target = await context.files.readlink({ path: resolvedPath });
    let symlinkBroken = false;
    try {
      await context.files.resolve({ path: resolvedPath });
    } catch {
      symlinkBroken = true;
    }
    return {
      displayPath: path,
      resolvedPath,
      fileType: lstat.type,
      size: lstat.size,
      symlinkTarget: target,
      symlinkBroken,
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
      symlinkBroken: false,
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
  context: WeshCommandContext,
  target: FileCommandTargetInfo,
}): Promise<FileCommandClassification> {
  switch (target.fileType) {
  case 'directory':
    return { kind: 'directory' };
  case 'fifo':
    return { kind: 'fifo' };
  case 'symlink':
    return {
      kind: 'symlink',
      target: target.symlinkTarget ?? '',
      broken: target.symlinkBroken,
    };
  case 'chardev':
    return { kind: 'data' };
  case 'file':
    break;
  default: {
    const _ex: never = target.fileType;
    throw new Error(`Unhandled stat file type: ${_ex}`);
  }
  }

  const bytes = await readFileSample({
    context,
    path: target.resolvedPath,
    size: target.size,
  });
  return classifyBytes({
    bytes,
    complete: bytes.byteLength === target.size,
    emptySource: 'file',
  });
}

export async function detectStdinClassification({
  context,
}: {
  context: WeshCommandContext,
}): Promise<FileCommandClassification> {
  const sample = await readStdinSample({ context });
  return classifyBytes({
    ...sample,
    emptySource: 'stdin',
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
