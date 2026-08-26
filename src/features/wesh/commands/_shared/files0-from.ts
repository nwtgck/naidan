import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import type { WeshCommandContext } from '@/features/wesh/types';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';

export interface NullTerminatedPathnameRecord {
  value: string,
  sourceRecordNumber: number,
}

function combineByteFragments({
  fragments,
  finalFragment,
}: {
  fragments: Uint8Array[],
  finalFragment: Uint8Array,
}): Uint8Array {
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
}

function decodePathname({
  decoder,
  bytes,
  source,
}: {
  decoder: TextDecoder,
  bytes: Uint8Array,
  source: string,
}): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(`invalid UTF-8 pathname in '${source}'`);
  }
}

export async function* iterateNullTerminatedPathnames({
  context,
  source,
}: {
  context: WeshCommandContext,
  source: string,
}): AsyncIterable<NullTerminatedPathnameRecord> {
  const stream = await openCommandInputStream({
    context,
    input: source,
  });
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let fragments: Uint8Array[] = [];
  let sourceRecordNumber = 1;

  for await (const chunk of iterateReadableStreamChunks({ stream })) {
    let recordStart = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0) {
        continue;
      }

      const bytes = combineByteFragments({
        fragments,
        finalFragment: chunk.subarray(recordStart, index),
      });
      yield {
        value: decodePathname({ decoder, bytes, source }),
        sourceRecordNumber,
      };
      sourceRecordNumber += 1;
      fragments = [];
      recordStart = index + 1;
    }

    if (recordStart < chunk.byteLength) {
      fragments.push(chunk.subarray(recordStart));
    }
  }

  if (fragments.length > 0) {
    yield {
      value: decodePathname({
        decoder,
        bytes: combineByteFragments({
          fragments,
          finalFragment: new Uint8Array(0),
        }),
        source,
      }),
      sourceRecordNumber,
    };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
