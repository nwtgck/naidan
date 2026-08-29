import type { WeshFileHandle } from '@/features/wesh/types';
import { decodeShellUtf8Text, findShellUtf8ByteOffsetForTextBoundary } from './byte-text';

export type ShellSource =
  | {
      readonly kind: 'text',
      readonly text: string,
    }
  | {
      readonly kind: 'bytes',
      read({ maximumBytes }: {
        maximumBytes: number,
      }): Promise<Uint8Array | undefined>,
    }
  | {
      readonly kind: 'handle',
      readonly handle: WeshFileHandle,
    };

export type ShellSourceReader = {
  read(): Promise<{
    text: string,
    completion: 'complete' | 'may-continue',
  }>,
  consumeText({ characters }: {
    characters: number,
  }): void,
  readRetainedBytes({ buffer, offset, length }: {
    buffer: Uint8Array,
    offset: number,
    length: number,
  }): number,
  getRetainedText(): string,
};

export function createTextShellSource({ text }: {
  text: string,
}): ShellSource {
  return {
    kind: 'text',
    text,
  };
}

export function createHandleShellSource({ handle }: {
  handle: WeshFileHandle,
}): ShellSource {
  return {
    kind: 'handle',
    handle,
  };
}

async function readShellSourceHandle({ handle, maximumBytes }: {
  handle: WeshFileHandle,
  maximumBytes: number,
}): Promise<Uint8Array | undefined> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error('Shell source maximumBytes must be a positive safe integer');
  }

  const buffer = new Uint8Array(maximumBytes);
  const { bytesRead } = await handle.read({
    buffer,
    offset: 0,
    length: maximumBytes,
    position: undefined,
  });
  if (bytesRead === 0) {
    return undefined;
  }
  if (bytesRead < 0 || bytesRead > maximumBytes) {
    throw new Error(`Shell source handle returned invalid bytesRead: ${bytesRead}`);
  }
  return buffer.subarray(0, bytesRead);
}


export function createShebangStrippedShellSource({ source }: {
  source: ShellSource,
}): ShellSource {
  switch (source.kind) {
  case 'text':
    return createTextShellSource({
      text: stripShebangText({ text: source.text }),
    });
  case 'bytes':
  case 'handle': {
    const readSource = ({ maximumBytes }: { maximumBytes: number }) => {
      switch (source.kind) {
      case 'bytes':
        return source.read({ maximumBytes });
      case 'handle':
        return readShellSourceHandle({ handle: source.handle, maximumBytes });
      default: {
        const _ex: never = source;
        throw new Error(`Unhandled shell source: ${JSON.stringify(_ex)}`);
      }
      }
    };
    let state: 'checking-prefix' | 'skipping-shebang' | 'passthrough' | 'complete' = 'checking-prefix';
    let prefix = new Uint8Array(0);
    let pendingOutput = new Uint8Array(0);

    const takePendingOutput = ({ maximumBytes }: {
      maximumBytes: number,
    }): Uint8Array | undefined => {
      if (pendingOutput.length === 0) {
        return undefined;
      }
      const output = pendingOutput.subarray(0, maximumBytes);
      pendingOutput = pendingOutput.subarray(output.length);
      return output;
    };

    return {
      kind: 'bytes',
      async read({ maximumBytes }: {
        maximumBytes: number,
      }): Promise<Uint8Array | undefined> {
        if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
          throw new Error('Shell source maximumBytes must be a positive safe integer');
        }

        const pending = takePendingOutput({ maximumBytes });
        if (pending !== undefined) {
          return pending;
        }

        while (true) {
          switch (state) {
          case 'complete':
            return undefined;
          case 'passthrough':
            return readSource({ maximumBytes });
          case 'skipping-shebang': {
            const next = await readSource({ maximumBytes });
            if (next === undefined) {
              state = 'complete';
              return undefined;
            }
            if (next.length === 0) {
              throw new Error('Shell source returned an empty chunk before end of source');
            }
            const newlineIndex = next.indexOf(0x0a);
            if (newlineIndex < 0) {
              continue;
            }
            state = 'passthrough';
            const output = next.subarray(newlineIndex + 1);
            if (output.length > 0) {
              return output;
            }
            return readSource({ maximumBytes });
          }
          case 'checking-prefix':
            break;
          default: {
            const _ex: never = state;
            throw new Error(`Unhandled shebang source state: ${_ex}`);
          }
          }

          const newlineIndex = prefix.indexOf(0x0a);
          if (newlineIndex >= 0) {
            state = 'passthrough';
            const startsWithShebang = prefix.length >= 2 && prefix[0] === 0x23 && prefix[1] === 0x21;
            pendingOutput = startsWithShebang ? prefix.subarray(newlineIndex + 1) : prefix;
            prefix = new Uint8Array(0);
            const output = takePendingOutput({ maximumBytes });
            if (output !== undefined) {
              return output;
            }
            return readSource({ maximumBytes });
          }

          if (prefix.length >= 2) {
            if (prefix[0] === 0x23 && prefix[1] === 0x21) {
              state = 'skipping-shebang';
              prefix = new Uint8Array(0);
              continue;
            }
            state = 'passthrough';
            pendingOutput = prefix;
            prefix = new Uint8Array(0);
            const output = takePendingOutput({ maximumBytes });
            if (output === undefined) {
              throw new Error('Expected non-empty shell source prefix');
            }
            return output;
          }

          const next = await readSource({ maximumBytes });
          if (next === undefined) {
            state = 'complete';
            pendingOutput = prefix;
            prefix = new Uint8Array(0);
            return takePendingOutput({ maximumBytes });
          }
          if (next.length === 0) {
            throw new Error('Shell source returned an empty chunk before end of source');
          }
          const combined = new Uint8Array(prefix.length + next.length);
          combined.set(prefix, 0);
          combined.set(next, prefix.length);
          prefix = combined;
        }
      },
    };
  }
  default: {
    const _ex: never = source;
    throw new Error(`Unhandled shell source: ${JSON.stringify(_ex)}`);
  }
  }
}

function stripShebangText({ text }: { text: string }): string {
  if (!text.startsWith('#!')) {
    return text;
  }
  const newlineIndex = text.indexOf('\n');
  if (newlineIndex < 0) {
    return '';
  }
  return text.slice(newlineIndex + 1);
}

const SHELL_SOURCE_READ_CHUNK_BYTES = 64 * 1024;
const NUL_BYTE = 0x00;

function createParserVisibleByteView({ rawBytes }: {
  rawBytes: Uint8Array,
}): Uint8Array {
  const firstNul = rawBytes.indexOf(NUL_BYTE);
  if (firstNul < 0) {
    return rawBytes;
  }

  let visibleLength = firstNul;
  for (let index = firstNul + 1; index < rawBytes.length; index += 1) {
    if (rawBytes[index] !== NUL_BYTE) {
      visibleLength += 1;
    }
  }

  const visibleBytes = new Uint8Array(visibleLength);
  visibleBytes.set(rawBytes.subarray(0, firstNul), 0);
  let outputIndex = firstNul;
  for (let index = firstNul + 1; index < rawBytes.length; index += 1) {
    const byte = rawBytes[index];
    if (byte === undefined) {
      throw new Error(`Missing shell source byte at offset ${index}`);
    }
    if (byte === NUL_BYTE) {
      continue;
    }
    visibleBytes[outputIndex] = byte;
    outputIndex += 1;
  }
  return visibleBytes;
}

function findRawByteOffsetForParserByteBoundary({ rawBytes, parserVisibleBytes, parserByteOffset }: {
  rawBytes: Uint8Array,
  parserVisibleBytes: Uint8Array,
  parserByteOffset: number,
}): number {
  if (!Number.isSafeInteger(parserByteOffset) || parserByteOffset < 0) {
    throw new Error(`Invalid shell source parser-byte offset: ${parserByteOffset}`);
  }
  if (parserByteOffset === 0) {
    return 0;
  }
  if (parserVisibleBytes === rawBytes) {
    if (parserByteOffset > rawBytes.length) {
      throw new Error(`Shell parser consumed beyond available source bytes: ${parserByteOffset}`);
    }
    return parserByteOffset;
  }

  let visibleBytes = 0;
  for (let index = 0; index < rawBytes.length; index += 1) {
    if (rawBytes[index] === NUL_BYTE) {
      continue;
    }
    visibleBytes += 1;
    if (visibleBytes === parserByteOffset) {
      return index + 1;
    }
  }
  throw new Error(`Shell parser consumed beyond available source bytes: ${parserByteOffset}`);
}

class ShellSourceByteBuffer {
  private storage: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private start = 0;
  private length = 0;

  view(): Uint8Array<ArrayBuffer> {
    return this.storage.subarray(this.start, this.start + this.length);
  }

  append({ bytes }: { bytes: Uint8Array }) {
    if (bytes.length === 0) {
      return;
    }
    const availableAtEnd = this.storage.length - (this.start + this.length);
    if (availableAtEnd < bytes.length) {
      const availableAfterCompaction = this.storage.length - this.length;
      if (availableAfterCompaction >= bytes.length) {
        this.storage.copyWithin(0, this.start, this.start + this.length);
        this.start = 0;
      } else {
        const requiredLength = this.length + bytes.length;
        let capacity = Math.max(SHELL_SOURCE_READ_CHUNK_BYTES, this.storage.length);
        while (capacity < requiredLength) {
          capacity = Math.max(requiredLength, capacity * 2);
        }
        const expanded = new Uint8Array(capacity);
        expanded.set(this.view(), 0);
        this.storage = expanded;
        this.start = 0;
      }
    }
    this.storage.set(bytes, this.start + this.length);
    this.length += bytes.length;
  }

  consume({ bytes }: { bytes: number }) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.length) {
      throw new Error(`Invalid shell source retained-byte consumption: ${bytes}`);
    }
    this.start += bytes;
    this.length -= bytes;
    if (this.length === 0) {
      this.start = 0;
    }
  }

  read({ buffer, offset, length }: {
    buffer: Uint8Array,
    offset: number,
    length: number,
  }): number {
    const bytesRead = Math.min(length, this.length);
    if (bytesRead === 0) {
      return 0;
    }
    buffer.set(this.view().subarray(0, bytesRead), offset);
    this.consume({ bytes: bytesRead });
    return bytesRead;
  }
}

export function createShellSourceReader({ source }: {
  source: ShellSource,
}): ShellSourceReader {
  switch (source.kind) {
  case 'text': {
    let unreadText = source.text;
    let emitted = false;
    return {
      async read() {
        if (emitted) {
          return {
            text: '',
            completion: 'complete',
          };
        }
        emitted = true;
        return {
          text: unreadText,
          completion: 'complete',
        };
      },
      consumeText({ characters }) {
        if (!Number.isSafeInteger(characters) || characters < 0 || characters > unreadText.length) {
          throw new Error(`Invalid shell source text consumption: ${characters}`);
        }
        unreadText = unreadText.slice(characters);
      },
      readRetainedBytes() {
        return 0;
      },
      getRetainedText() {
        return unreadText;
      },
    };
  }
  case 'bytes':
  case 'handle': {
    const readSource = ({ maximumBytes }: { maximumBytes: number }) => {
      switch (source.kind) {
      case 'bytes':
        return source.read({ maximumBytes });
      case 'handle':
        return readShellSourceHandle({ handle: source.handle, maximumBytes });
      default: {
        const _ex: never = source;
        throw new Error(`Unhandled shell source: ${JSON.stringify(_ex)}`);
      }
      }
    };
    let completion: 'complete' | 'may-continue' = 'may-continue';
    const retainedBytes = new ShellSourceByteBuffer();
    let retainedText = '';
    let projectedBytes = 0;
    const projectionSegments: Array<{
      textCharacters: number,
      rawBytes: number,
    }> = [];

    const appendProjection = (): string => {
      const rawBytes = retainedBytes.view().subarray(projectedBytes);
      const parserVisibleBytes = createParserVisibleByteView({ rawBytes });
      const projection = decodeShellUtf8Text({
        bytes: parserVisibleBytes,
        completion,
      });
      let consumedRawBytes = findRawByteOffsetForParserByteBoundary({
        rawBytes,
        parserVisibleBytes,
        parserByteOffset: projection.consumedBytes,
      });
      switch (completion) {
      case 'complete':
        if (projection.consumedBytes !== parserVisibleBytes.length) {
          throw new Error('Complete shell source left parser-visible bytes unprojected');
        }
        consumedRawBytes = rawBytes.length;
        break;
      case 'may-continue':
        break;
      default: {
        const _ex: never = completion;
        throw new Error(`Unhandled shell source completion: ${_ex}`);
      }
      }
      if (consumedRawBytes > 0) {
        if (projection.text.length === 0) {
          const previousSegment = projectionSegments.at(-1);
          if (previousSegment !== undefined) {
            previousSegment.rawBytes += consumedRawBytes;
          }
        } else {
          projectionSegments.push({
            textCharacters: projection.text.length,
            rawBytes: consumedRawBytes,
          });
        }
      }
      retainedText += projection.text;
      projectedBytes += consumedRawBytes;
      return projection.text;
    };

    const rebuildProjection = () => {
      retainedText = '';
      projectedBytes = 0;
      projectionSegments.length = 0;
      appendProjection();
    };

    return {
      async read() {
        switch (completion) {
        case 'complete':
          return {
            text: '',
            completion,
          };
        case 'may-continue':
          break;
        default: {
          const _ex: never = completion;
          throw new Error(`Unhandled shell source completion: ${_ex}`);
        }
        }

        const chunk = await readSource({
          maximumBytes: SHELL_SOURCE_READ_CHUNK_BYTES,
        });
        if (chunk === undefined) {
          completion = 'complete';
          return {
            text: appendProjection(),
            completion,
          };
        }
        if (chunk.length === 0) {
          throw new Error('Shell source returned an empty chunk before end of source');
        }
        retainedBytes.append({ bytes: chunk });
        return {
          text: appendProjection(),
          completion,
        };
      },
      consumeText({ characters }) {
        if (!Number.isSafeInteger(characters) || characters < 0 || characters > retainedText.length) {
          throw new Error(`Invalid shell source text consumption: ${characters}`);
        }
        let remainingCharacters = characters;
        let rawBytesConsumed = 0;
        let fullyConsumedSegments = 0;
        while (remainingCharacters > 0) {
          const segment = projectionSegments[fullyConsumedSegments];
          if (segment === undefined) {
            throw new Error('Shell parser consumed beyond retained source projection');
          }
          if (remainingCharacters >= segment.textCharacters) {
            remainingCharacters -= segment.textCharacters;
            rawBytesConsumed += segment.rawBytes;
            fullyConsumedSegments += 1;
            continue;
          }

          const segmentBytes = retainedBytes.view().subarray(
            rawBytesConsumed,
            rawBytesConsumed + segment.rawBytes,
          );
          const parserVisibleBytes = createParserVisibleByteView({ rawBytes: segmentBytes });
          const partialParserBytes = findShellUtf8ByteOffsetForTextBoundary({
            bytes: parserVisibleBytes,
            completion: 'complete',
            characters: remainingCharacters,
          });
          const partialRawBytes = findRawByteOffsetForParserByteBoundary({
            rawBytes: segmentBytes,
            parserVisibleBytes,
            parserByteOffset: partialParserBytes,
          });
          projectionSegments[fullyConsumedSegments] = {
            textCharacters: segment.textCharacters - remainingCharacters,
            rawBytes: segment.rawBytes - partialRawBytes,
          };
          rawBytesConsumed += partialRawBytes;
          remainingCharacters = 0;
        }
        if (fullyConsumedSegments > 0) {
          projectionSegments.splice(0, fullyConsumedSegments);
        }
        if (rawBytesConsumed > projectedBytes) {
          throw new Error('Shell parser consumed bytes not yet available in its text projection');
        }
        retainedBytes.consume({ bytes: rawBytesConsumed });
        projectedBytes -= rawBytesConsumed;
        retainedText = retainedText.slice(characters);
      },
      readRetainedBytes({ buffer, offset, length }) {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length) {
          throw new Error(`Invalid shell source retained-byte offset: ${offset}`);
        }
        if (!Number.isSafeInteger(length) || length < 0 || offset + length > buffer.length) {
          throw new Error(`Invalid shell source retained-byte length: ${length}`);
        }
        const bytesRead = retainedBytes.read({ buffer, offset, length });
        if (bytesRead > 0) {
          rebuildProjection();
        }
        return bytesRead;
      },
      getRetainedText() {
        return retainedText;
      },
    };
  }
  default: {
    const _ex: never = source;
    throw new Error(`Unhandled shell source: ${JSON.stringify(_ex)}`);
  }
  }
}

/**
 * Whole-source bridge for call sites that still require one parser-visible immutable string.
 * Byte-backed sources use the same projection as incremental shell parsing; callers that need
 * byte identity must consume the underlying ShellSource instead. Shell execution itself should
 * consume ShellSourceReader incrementally.
 */
export async function readShellSourceToText({ source }: {
  source: ShellSource,
}): Promise<string> {
  const reader = createShellSourceReader({ source });
  const parts: string[] = [];

  while (true) {
    const next = await reader.read();
    parts.push(next.text);
    switch (next.completion) {
    case 'complete':
      return parts.join('');
    case 'may-continue':
      break;
    default: {
      const _ex: never = next.completion;
      throw new Error(`Unhandled shell source completion: ${_ex}`);
    }
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
