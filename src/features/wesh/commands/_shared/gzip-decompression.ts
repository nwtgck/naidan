import type { WeshFileHandle } from '@/features/wesh/types';
import { writeAllBytesToHandle } from '@/features/wesh/utils/fs';
import {
  iterateReadableStreamChunks,
  pipeThroughBufferSourceTransform,
} from '@/features/wesh/utils/stream';

const GZIP_MAGIC_FIRST = 0x1F;
const GZIP_MAGIC_SECOND = 0x8B;
const GZIP_METHOD_DEFLATE = 0x08;
const GZIP_FLAG_HEADER_CRC = 0x02;
const GZIP_FLAG_EXTRA = 0x04;
const GZIP_FLAG_FILE_NAME = 0x08;
const GZIP_FLAG_COMMENT = 0x10;
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

type GzipHeaderStage =
  | 'fixed'
  | 'extra-length-low'
  | 'extra-length-high'
  | 'extra-data'
  | 'file-name'
  | 'comment'
  | 'header-crc'
  | 'done'
  | 'invalid';

class GzipHeaderLengthTracker {
  private readonly fixedHeader = new Uint8Array(10);
  private fixedHeaderLength = 0;
  private stage: GzipHeaderStage = 'fixed';
  private flags = 0;
  private extraLengthLow = 0;
  private extraBytesRemaining = 0;
  private headerCrcBytesRemaining = 0;
  private totalBytes = 0;
  private completedHeaderBytes: number | undefined;

  private advanceOptionalFields(): void {
    if ((this.flags & GZIP_FLAG_EXTRA) !== 0) {
      this.stage = 'extra-length-low';
      return;
    }
    if ((this.flags & GZIP_FLAG_FILE_NAME) !== 0) {
      this.stage = 'file-name';
      return;
    }
    if ((this.flags & GZIP_FLAG_COMMENT) !== 0) {
      this.stage = 'comment';
      return;
    }
    if ((this.flags & GZIP_FLAG_HEADER_CRC) !== 0) {
      this.stage = 'header-crc';
      this.headerCrcBytesRemaining = 2;
      return;
    }
    this.stage = 'done';
    this.completedHeaderBytes = this.totalBytes;
  }

  private completeOptionalField({
    completed,
  }: {
    completed: 'extra' | 'file-name' | 'comment' | 'header-crc',
  }): void {
    switch (completed) {
    case 'extra':
      this.flags &= ~GZIP_FLAG_EXTRA;
      break;
    case 'file-name':
      this.flags &= ~GZIP_FLAG_FILE_NAME;
      break;
    case 'comment':
      this.flags &= ~GZIP_FLAG_COMMENT;
      break;
    case 'header-crc':
      this.flags &= ~GZIP_FLAG_HEADER_CRC;
      break;
    default: {
      const _ex: never = completed;
      throw new Error(`Unhandled gzip optional header field: ${_ex}`);
    }
    }
    this.advanceOptionalFields();
  }

  private currentStage(): GzipHeaderStage {
    return this.stage;
  }

  append({ chunk }: { chunk: Uint8Array }): void {
    if (this.currentStage() === 'done' || this.currentStage() === 'invalid') return;

    for (const byte of chunk) {
      const stage = this.currentStage();
      if (stage === 'done' || stage === 'invalid') return;
      this.totalBytes += 1;

      switch (stage) {
      case 'fixed': {
        this.fixedHeader[this.fixedHeaderLength] = byte;
        this.fixedHeaderLength += 1;
        if (this.fixedHeaderLength < this.fixedHeader.byteLength) break;
        if (
          this.fixedHeader[0] !== GZIP_MAGIC_FIRST
          || this.fixedHeader[1] !== GZIP_MAGIC_SECOND
          || this.fixedHeader[2] !== GZIP_METHOD_DEFLATE
        ) {
          this.stage = 'invalid';
          break;
        }
        this.flags = this.fixedHeader[3] ?? 0;
        this.advanceOptionalFields();
        break;
      }
      case 'extra-length-low':
        this.extraLengthLow = byte;
        this.stage = 'extra-length-high';
        break;
      case 'extra-length-high':
        this.extraBytesRemaining = this.extraLengthLow | (byte << 8);
        if (this.extraBytesRemaining === 0) {
          this.completeOptionalField({ completed: 'extra' });
        } else {
          this.stage = 'extra-data';
        }
        break;
      case 'extra-data':
        this.extraBytesRemaining -= 1;
        if (this.extraBytesRemaining === 0) {
          this.completeOptionalField({ completed: 'extra' });
        }
        break;
      case 'file-name':
        if (byte === 0) this.completeOptionalField({ completed: 'file-name' });
        break;
      case 'comment':
        if (byte === 0) this.completeOptionalField({ completed: 'comment' });
        break;
      case 'header-crc':
        this.headerCrcBytesRemaining -= 1;
        if (this.headerCrcBytesRemaining === 0) {
          this.completeOptionalField({ completed: 'header-crc' });
        }
        break;
      default: {
        const _ex: never = stage;
        throw new Error(`Unhandled gzip header stage: ${_ex}`);
      }
      }
    }
  }

  headerBytes(): number | undefined {
    return this.completedHeaderBytes;
  }
}

type GzipInputMetricsAccumulator = {
  compressedBytes: number,
  readonly headerLengthTracker: GzipHeaderLengthTracker,
};

export type GzipDecompressionMetrics = {
  readonly result: GzipDecompressionResult,
  readonly compressedBytes: number,
  readonly uncompressedBytes: number,
  readonly headerBytes: number | undefined,
};

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
  inputMetrics,
}: {
  source: ReadableStream<Uint8Array>,
  inputTail: ByteTail,
  inputMetrics: GzipInputMetricsAccumulator,
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
        inputMetrics.compressedBytes += result.value.byteLength;
        inputMetrics.headerLengthTracker.append({ chunk: result.value });
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

export async function consumeGzipInputWithMetrics({
  source,
  output,
}: {
  source: ReadableStream<Uint8Array>,
  output: WeshFileHandle | undefined,
}): Promise<GzipDecompressionMetrics> {
  const inputTail = new ByteTail();
  const inputMetrics: GzipInputMetricsAccumulator = {
    compressedBytes: 0,
    headerLengthTracker: new GzipHeaderLengthTracker(),
  };
  const decompressedStream = pipeThroughBufferSourceTransform({
    source: rechunkGzipTail({ source, inputTail, inputMetrics }),
    transform: new DecompressionStream('gzip'),
  });
  let crc = 0xFFFF_FFFF;
  let outputSizeModulo32 = 0;
  let uncompressedBytes = 0;
  let result: GzipDecompressionResult;
  try {
    for await (const chunk of iterateReadableStreamChunks({ stream: decompressedStream })) {
      crc = updateCrc32({ crc, chunk });
      outputSizeModulo32 = (outputSizeModulo32 + chunk.byteLength) >>> 0;
      uncompressedBytes += chunk.byteLength;
      if (output !== undefined) {
        await writeAllBytesToHandle({ handle: output, data: chunk });
      }
    }
    result = 'success';
  } catch {
    const outputCrc = (crc ^ 0xFFFF_FFFF) >>> 0;
    const tail = inputTail.value();
    const footerEndOffset = findMatchingGzipFooterEndOffset({
      inputTail: tail,
      outputCrc,
      outputSize: outputSizeModulo32,
    });
    if (footerEndOffset === undefined) {
      result = 'invalid';
    } else {
      const trailing = tail.subarray(footerEndOffset);
      result = trailing[0] === GZIP_MAGIC_FIRST && trailing[1] === GZIP_MAGIC_SECOND
        ? 'invalid'
        : 'trailing_garbage';
    }
  }

  return {
    result,
    compressedBytes: inputMetrics.compressedBytes,
    uncompressedBytes,
    headerBytes: inputMetrics.headerLengthTracker.headerBytes(),
  };
}

export async function consumeGzipInput({
  source,
  output,
}: {
  source: ReadableStream<Uint8Array>,
  output: WeshFileHandle | undefined,
}): Promise<GzipDecompressionResult> {
  return (await consumeGzipInputWithMetrics({ source, output })).result;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
  hasMatchingGzipFooter,
  updateCrc32,
};
