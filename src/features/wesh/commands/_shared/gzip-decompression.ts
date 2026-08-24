import type { WeshFileHandle } from '@/features/wesh/types';
import { writeAllBytesToHandle } from '@/features/wesh/utils/fs';
import {
  iterateReadableStreamChunks,
  pipeThroughBufferSourceTransform,
} from '@/features/wesh/utils/stream';

const GZIP_MAGIC_FIRST = 0x1F;
const GZIP_MAGIC_SECOND = 0x8B;
const GZIP_RETAINED_TAIL_BYTES = 32;
// Feed only the retained tail byte-by-byte. Browser DecompressionStream may hold
// decoded output until a later compressed byte arrives; one-byte delivery lets it
// expose the same confirmed payload GNU gzip writes before a truncated footer.
const GZIP_FINAL_INPUT_CHUNK_BYTES = 1;
const GZIP_DIAGNOSTIC_TAIL_BYTES = 64 * 1024;

export type GzipDecompressionResult =
  | 'success'
  | 'invalid'
  | 'trailing_garbage';

class ByteTail {
  private bytes = new Uint8Array(0);

  append({
    chunk,
  }: {
    chunk: Uint8Array,
  }): void {
    if (chunk.byteLength >= GZIP_DIAGNOSTIC_TAIL_BYTES) {
      this.bytes = chunk.slice(chunk.byteLength - GZIP_DIAGNOSTIC_TAIL_BYTES);
      return;
    }
    const retainedBytes = Math.min(
      this.bytes.byteLength,
      GZIP_DIAGNOSTIC_TAIL_BYTES - chunk.byteLength,
    );
    const next = new Uint8Array(retainedBytes + chunk.byteLength);
    next.set(this.bytes.subarray(this.bytes.byteLength - retainedBytes), 0);
    next.set(chunk, retainedBytes);
    this.bytes = next;
  }

  value(): Uint8Array {
    return this.bytes;
  }
}

function concatenateBytes({
  left,
  right,
}: {
  left: Uint8Array,
  right: Uint8Array,
}): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

export async function peekGzipInput({
  source,
}: {
  source: ReadableStream<Uint8Array>,
}): Promise<{ stream: ReadableStream<Uint8Array>, isGzip: boolean }> {
  const reader = source.getReader();
  const prefixChunks: Uint8Array[] = [];
  let prefixLength = 0;
  while (prefixLength < 2) {
    const result = await reader.read();
    if (result.done) break;
    prefixChunks.push(result.value);
    prefixLength += result.value.byteLength;
  }

  const prefix = new Uint8Array(prefixLength);
  let prefixOffset = 0;
  for (const chunk of prefixChunks) {
    prefix.set(chunk, prefixOffset);
    prefixOffset += chunk.byteLength;
  }
  let queuedIndex = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (queuedIndex < prefixChunks.length) {
        controller.enqueue(prefixChunks[queuedIndex]!);
        queuedIndex += 1;
        return;
      }
      const result = await reader.read();
      if (result.done) {
        controller.close();
        reader.releaseLock();
        return;
      }
      controller.enqueue(result.value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
      reader.releaseLock();
    },
  });

  return {
    stream,
    isGzip: prefix[0] === GZIP_MAGIC_FIRST && prefix[1] === GZIP_MAGIC_SECOND,
  };
}

function rechunkGzipTail({
  source,
  inputTail,
}: {
  source: ReadableStream<Uint8Array>,
  inputTail: ByteTail,
}): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let sourceDone = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!sourceDone && pending.byteLength <= GZIP_RETAINED_TAIL_BYTES) {
        const result = await reader.read();
        if (result.done) {
          sourceDone = true;
          reader.releaseLock();
          break;
        }
        inputTail.append({ chunk: result.value });
        pending = concatenateBytes({ left: pending, right: result.value });
      }

      if (!sourceDone && pending.byteLength > GZIP_RETAINED_TAIL_BYTES) {
        const emittedLength = pending.byteLength - GZIP_RETAINED_TAIL_BYTES;
        controller.enqueue(pending.slice(0, emittedLength));
        pending = pending.slice(emittedLength);
        return;
      }

      if (pending.byteLength > 0) {
        const emittedLength = Math.min(
          pending.byteLength,
          GZIP_FINAL_INPUT_CHUNK_BYTES,
        );
        controller.enqueue(pending.slice(0, emittedLength));
        pending = pending.slice(emittedLength);
        return;
      }

      controller.close();
    },
    async cancel(reason) {
      if (!sourceDone) {
        await reader.cancel(reason);
        reader.releaseLock();
      }
    },
  });
}

function updateCrc32({
  crc,
  chunk,
}: {
  crc: number,
  chunk: Uint8Array,
}): number {
  let nextCrc = crc;
  for (const byte of chunk) {
    nextCrc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      nextCrc = (nextCrc >>> 1) ^ ((nextCrc & 1) === 0 ? 0 : 0xEDB88320);
    }
  }
  return nextCrc >>> 0;
}

function readUint32LittleEndian({
  bytes,
  offset,
}: {
  bytes: Uint8Array,
  offset: number,
}): number {
  return (
    (bytes[offset] ?? 0)
    | ((bytes[offset + 1] ?? 0) << 8)
    | ((bytes[offset + 2] ?? 0) << 16)
    | ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function findMatchingGzipFooterEndOffset({
  inputTail,
  outputCrc,
  outputSize,
}: {
  inputTail: Uint8Array,
  outputCrc: number,
  outputSize: number,
}): number | undefined {
  for (let offset = 0; offset + 8 <= inputTail.byteLength; offset += 1) {
    if (
      readUint32LittleEndian({ bytes: inputTail, offset }) === outputCrc
      && readUint32LittleEndian({ bytes: inputTail, offset: offset + 4 }) === outputSize
    ) {
      return offset + 8;
    }
  }
  return undefined;
}

function hasMatchingGzipFooter({
  inputTail,
  outputCrc,
  outputSize,
}: {
  inputTail: Uint8Array,
  outputCrc: number,
  outputSize: number,
}): boolean {
  return findMatchingGzipFooterEndOffset({ inputTail, outputCrc, outputSize }) !== undefined;
}

export async function consumeGzipInput({
  source,
  output,
}: {
  source: ReadableStream<Uint8Array>,
  output: WeshFileHandle | undefined,
}): Promise<GzipDecompressionResult> {
  const inputTail = new ByteTail();
  const decompressedStream = pipeThroughBufferSourceTransform({
    source: rechunkGzipTail({ source, inputTail }),
    transform: new DecompressionStream('gzip'),
  });
  let crc = 0xFFFF_FFFF;
  let outputSize = 0;
  try {
    for await (const chunk of iterateReadableStreamChunks({ stream: decompressedStream })) {
      crc = updateCrc32({ crc, chunk });
      outputSize = (outputSize + chunk.byteLength) >>> 0;
      if (output !== undefined) {
        await writeAllBytesToHandle({ handle: output, data: chunk });
      }
    }
    return 'success';
  } catch {
    const outputCrc = (crc ^ 0xFFFF_FFFF) >>> 0;
    const tail = inputTail.value();
    const footerEndOffset = findMatchingGzipFooterEndOffset({
      inputTail: tail,
      outputCrc,
      outputSize,
    });
    if (footerEndOffset === undefined) return 'invalid';
    const trailing = tail.subarray(footerEndOffset);
    return trailing[0] === GZIP_MAGIC_FIRST && trailing[1] === GZIP_MAGIC_SECOND
      ? 'invalid'
      : 'trailing_garbage';
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
  hasMatchingGzipFooter,
  updateCrc32,
};
