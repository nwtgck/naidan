const NEWLINE_BYTE = 0x0a;
const CARRIAGE_RETURN_BYTE = 0x0d;

export type WeshTextRecordTermination = 'delimiter' | 'end_of_input';

export interface WeshTextRecord {
  readonly text: string,
  readonly bytes: Uint8Array | undefined,
  readonly termination: WeshTextRecordTermination,
  readonly byteLength: number,
}

export interface WeshByteRecord {
  readonly bytes: Uint8Array,
  readonly termination: WeshTextRecordTermination,
  readonly byteLength: number,
}

export function getWeshTextRecordTerminator({
  termination,
}: {
  termination: WeshTextRecordTermination,
}): '' | '\n' {
  switch (termination) {
  case 'delimiter':
    return '\n';
  case 'end_of_input':
    return '';
  default: {
    const _ex: never = termination;
    throw new Error(`Unhandled text record termination: ${_ex}`);
  }
  }
}

function collectUtf8RecordBytes({
  fragments,
  fragmentsByteLength,
  finalFragment,
}: {
  fragments: readonly Uint8Array[],
  fragmentsByteLength: number,
  finalFragment: Uint8Array,
}): Uint8Array {
  if (fragments.length === 0) {
    return finalFragment;
  }

  const totalLength = fragmentsByteLength + finalFragment.byteLength;
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const fragment of fragments) {
    combined.set(fragment, offset);
    offset += fragment.byteLength;
  }
  combined.set(finalFragment, offset);
  return combined;
}

export async function* iterateByteRecordEntries({
  chunks,
  delimiterByte,
}: {
  chunks: AsyncIterable<Uint8Array>,
  delimiterByte: number,
}): AsyncIterable<WeshByteRecord> {
  let fragments: Uint8Array[] = [];
  let fragmentsByteLength = 0;

  for await (const chunk of chunks) {
    let recordStart = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== delimiterByte) {
        continue;
      }

      yield {
        bytes: collectUtf8RecordBytes({
          fragments,
          fragmentsByteLength,
          finalFragment: chunk.subarray(recordStart, index),
        }),
        termination: 'delimiter',
        byteLength: fragmentsByteLength + index - recordStart + 1,
      };
      fragments = [];
      fragmentsByteLength = 0;
      recordStart = index + 1;
    }

    if (recordStart < chunk.byteLength) {
      const fragment = chunk.subarray(recordStart);
      fragments.push(fragment);
      fragmentsByteLength += fragment.byteLength;
    }
  }

  if (fragments.length > 0) {
    yield {
      bytes: collectUtf8RecordBytes({
        fragments,
        fragmentsByteLength,
        finalFragment: new Uint8Array(0),
      }),
      termination: 'end_of_input',
      byteLength: fragmentsByteLength,
    };
  }
}

export function materializeByteRecord({
  record,
  delimiterByte,
}: {
  record: WeshByteRecord,
  delimiterByte: number,
}): Uint8Array {
  switch (record.termination) {
  case 'end_of_input':
    return record.bytes;
  case 'delimiter': {
    const result = new Uint8Array(record.bytes.byteLength + 1);
    result.set(record.bytes);
    result[result.byteLength - 1] = delimiterByte;
    return result;
  }
  default: {
    const _ex: never = record.termination;
    throw new Error(`Unhandled byte record termination: ${_ex}`);
  }
  }
}

function decodeUtf8Record({
  decoder,
  bytes,
  stripTrailingCarriageReturn,
}: {
  decoder: TextDecoder,
  bytes: Uint8Array,
  stripTrailingCarriageReturn: boolean,
}): { bytes: Uint8Array, text: string } {
  const decodedLength = stripTrailingCarriageReturn
    && bytes.byteLength > 0
    && bytes[bytes.byteLength - 1] === CARRIAGE_RETURN_BYTE
    ? bytes.byteLength - 1
    : bytes.byteLength;
  const decodedBytes = bytes.subarray(0, decodedLength);
  return {
    bytes: decodedBytes,
    text: decoder.decode(decodedBytes),
  };
}

export async function* iterateUtf8RecordEntries({
  chunks,
  delimiterByte,
  stripTrailingCarriageReturn,
  includeBytes,
}: {
  chunks: AsyncIterable<Uint8Array>,
  delimiterByte: number,
  stripTrailingCarriageReturn: boolean,
  includeBytes: boolean,
}): AsyncIterable<WeshTextRecord> {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  for await (const record of iterateByteRecordEntries({ chunks, delimiterByte })) {
    const shouldStripTrailingCarriageReturn = (() => {
      switch (record.termination) {
      case 'delimiter':
        return stripTrailingCarriageReturn;
      case 'end_of_input':
        return false;
      default: {
        const _ex: never = record.termination;
        throw new Error(`Unhandled text record termination: ${_ex}`);
      }
      }
    })();
    const decodedRecord = decodeUtf8Record({
      decoder,
      bytes: record.bytes,
      stripTrailingCarriageReturn: shouldStripTrailingCarriageReturn,
    });
    yield {
      text: decodedRecord.text,
      bytes: includeBytes ? decodedRecord.bytes : undefined,
      termination: record.termination,
      byteLength: record.byteLength,
    };
  }
}

export async function* iterateUtf8Records({
  chunks,
  delimiterByte,
  stripTrailingCarriageReturn,
}: {
  chunks: AsyncIterable<Uint8Array>,
  delimiterByte: number,
  stripTrailingCarriageReturn: boolean,
}): AsyncIterable<string> {
  for await (const record of iterateUtf8RecordEntries({
    chunks,
    delimiterByte,
    stripTrailingCarriageReturn,
    includeBytes: false,
  })) {
    yield record.text;
  }
}

export function iterateUtf8LineRecords({
  chunks,
}: {
  chunks: AsyncIterable<Uint8Array>,
}): AsyncIterable<WeshTextRecord> {
  return iterateUtf8RecordEntries({
    chunks,
    delimiterByte: NEWLINE_BYTE,
    stripTrailingCarriageReturn: true,
    includeBytes: false,
  });
}

/**
 * Iterates UTF-8 lines from byte chunks without repeatedly concatenating the
 * complete unfinished line. Memory is bounded by the longest line plus the
 * caller's chunk buffer.
 */
export function iterateUtf8Lines({
  chunks,
}: {
  chunks: AsyncIterable<Uint8Array>,
}): AsyncIterable<string> {
  return iterateUtf8Records({
    chunks,
    delimiterByte: NEWLINE_BYTE,
    stripTrailingCarriageReturn: true,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  iterateByteRecordEntries,
  materializeByteRecord,
};
