const GZIP_FIXED_HEADER_LENGTH = 10;
const GZIP_FILE_NAME_FLAG = 0x08;
const MAX_GZIP_MTIME_SECONDS = 0xffffffff;

function encodeGzipModificationTime({
  milliseconds,
}: {
  milliseconds: number,
}): number {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return 0;
  }

  return Math.min(
    Math.floor(milliseconds / 1000),
    MAX_GZIP_MTIME_SECONDS,
  );
}

function buildNamedGzipHeader({
  fixedHeader,
  fileName,
  mtime,
}: {
  fixedHeader: Uint8Array,
  fileName: string,
  mtime: number,
}): Uint8Array {
  if (
    fixedHeader.length !== GZIP_FIXED_HEADER_LENGTH
    || fixedHeader[0] !== 0x1f
    || fixedHeader[1] !== 0x8b
    || fixedHeader[2] !== 0x08
  ) {
    throw new Error('CompressionStream produced an invalid gzip header');
  }

  const fileNameBytes = new TextEncoder().encode(fileName);
  if (fileNameBytes.includes(0)) {
    throw new Error('gzip input file name contains a NUL byte');
  }

  const header = new Uint8Array(
    GZIP_FIXED_HEADER_LENGTH + fileNameBytes.length + 1,
  );
  header.set(fixedHeader, 0);
  header[3] = (header[3] ?? 0) | GZIP_FILE_NAME_FLAG;

  const seconds = encodeGzipModificationTime({ milliseconds: mtime });
  header[4] = seconds & 0xff;
  header[5] = (seconds >>> 8) & 0xff;
  header[6] = (seconds >>> 16) & 0xff;
  header[7] = (seconds >>> 24) & 0xff;

  header.set(fileNameBytes, GZIP_FIXED_HEADER_LENGTH);
  header[header.length - 1] = 0;
  return header;
}

export function addNamedGzipHeader({
  stream,
  fileName,
  mtime,
}: {
  stream: ReadableStream<Uint8Array>,
  fileName: string,
  mtime: number,
}): ReadableStream<Uint8Array> {
  let pending = new Uint8Array(0);
  let headerWritten = false;

  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (headerWritten) {
        controller.enqueue(chunk);
        return;
      }

      const combined = new Uint8Array(pending.length + chunk.length);
      combined.set(pending, 0);
      combined.set(chunk, pending.length);

      if (combined.length < GZIP_FIXED_HEADER_LENGTH) {
        pending = combined;
        return;
      }

      controller.enqueue(buildNamedGzipHeader({
        fixedHeader: combined.subarray(0, GZIP_FIXED_HEADER_LENGTH),
        fileName,
        mtime,
      }));
      if (combined.length > GZIP_FIXED_HEADER_LENGTH) {
        controller.enqueue(combined.subarray(GZIP_FIXED_HEADER_LENGTH));
      }
      pending = new Uint8Array(0);
      headerWritten = true;
    },
    flush() {
      if (!headerWritten) {
        throw new Error('CompressionStream ended before emitting a gzip header');
      }
    },
  }));
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  encodeGzipModificationTime,
};
