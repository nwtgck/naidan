const NEWLINE_BYTE = 0x0a;
const CARRIAGE_RETURN_BYTE = 0x0d;

export type WeshTextRecordTermination = 'delimiter' | 'end_of_input';

export interface WeshTextRecord {
  readonly text: string;
  readonly termination: WeshTextRecordTermination;
}

export function getWeshTextRecordTerminator({
  termination,
}: {
  termination: WeshTextRecordTermination;
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

function decodeUtf8Record({
  decoder,
  fragments,
  finalFragment,
  stripTrailingCarriageReturn,
}: {
  decoder: TextDecoder;
  fragments: readonly Uint8Array[];
  finalFragment: Uint8Array;
  stripTrailingCarriageReturn: boolean;
}): string {
  const bytes = (() => {
    if (fragments.length === 0) {
      return finalFragment;
    }

    const totalLength = fragments.reduce(
      (sum, fragment) => sum + fragment.byteLength,
      finalFragment.byteLength,
    );
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const fragment of fragments) {
      combined.set(fragment, offset);
      offset += fragment.byteLength;
    }
    combined.set(finalFragment, offset);
    return combined;
  })();

  const decodedLength = stripTrailingCarriageReturn
    && bytes.byteLength > 0
    && bytes[bytes.byteLength - 1] === CARRIAGE_RETURN_BYTE
    ? bytes.byteLength - 1
    : bytes.byteLength;

  return decoder.decode(bytes.subarray(0, decodedLength));
}

export async function* iterateUtf8RecordEntries({
  chunks,
  delimiterByte,
  stripTrailingCarriageReturn,
}: {
  chunks: AsyncIterable<Uint8Array>;
  delimiterByte: number;
  stripTrailingCarriageReturn: boolean;
}): AsyncIterable<WeshTextRecord> {
  const decoder = new TextDecoder();
  let fragments: Uint8Array[] = [];

  for await (const chunk of chunks) {
    let recordStart = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== delimiterByte) {
        continue;
      }

      yield {
        text: decodeUtf8Record({
          decoder,
          fragments,
          finalFragment: chunk.subarray(recordStart, index),
          stripTrailingCarriageReturn,
        }),
        termination: 'delimiter',
      };
      fragments = [];
      recordStart = index + 1;
    }

    if (recordStart < chunk.byteLength) {
      fragments.push(chunk.subarray(recordStart));
    }
  }

  if (fragments.length > 0) {
    yield {
      text: decodeUtf8Record({
        decoder,
        fragments,
        finalFragment: new Uint8Array(0),
        stripTrailingCarriageReturn: false,
      }),
      termination: 'end_of_input',
    };
  }
}

export async function* iterateUtf8Records({
  chunks,
  delimiterByte,
  stripTrailingCarriageReturn,
}: {
  chunks: AsyncIterable<Uint8Array>;
  delimiterByte: number;
  stripTrailingCarriageReturn: boolean;
}): AsyncIterable<string> {
  for await (const record of iterateUtf8RecordEntries({
    chunks,
    delimiterByte,
    stripTrailingCarriageReturn,
  })) {
    yield record.text;
  }
}

export function iterateUtf8LineRecords({
  chunks,
}: {
  chunks: AsyncIterable<Uint8Array>;
}): AsyncIterable<WeshTextRecord> {
  return iterateUtf8RecordEntries({
    chunks,
    delimiterByte: NEWLINE_BYTE,
    stripTrailingCarriageReturn: true,
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
  chunks: AsyncIterable<Uint8Array>;
}): AsyncIterable<string> {
  return iterateUtf8Records({
    chunks,
    delimiterByte: NEWLINE_BYTE,
    stripTrailingCarriageReturn: true,
  });
}
