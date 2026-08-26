export class CmpInputError extends Error {
  readonly side: 'left' | 'right';
  readonly originalError: unknown;

  constructor({
    side,
    originalError,
  }: {
    side: 'left' | 'right',
    originalError: unknown,
  }) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
    this.name = 'CmpInputError';
    this.side = side;
    this.originalError = originalError;
  }
}

export type CmpDifference =
  | {
      kind: 'byte',
      position: bigint,
      line: bigint,
      leftByte: number,
      rightByte: number,
    }
  | {
      kind: 'eof',
      shorter: 'left' | 'right',
      comparedBytes: bigint,
      line: bigint,
      afterRecordDelimiter: boolean,
    };

class CmpChunkCursor {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly side: 'left' | 'right';
  private chunk: Uint8Array | undefined;
  private offset = 0;
  private done = false;

  constructor({
    stream,
    side,
  }: {
    stream: ReadableStream<Uint8Array>,
    side: 'left' | 'right',
  }) {
    this.reader = stream.getReader();
    this.side = side;
  }

  async ensureAvailable(): Promise<boolean> {
    while (!this.done && (this.chunk === undefined || this.offset >= this.chunk.length)) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await this.reader.read();
      } catch (originalError: unknown) {
        throw new CmpInputError({ side: this.side, originalError });
      }
      if (result.done) {
        this.chunk = undefined;
        this.offset = 0;
        this.done = true;
        return false;
      }
      if (result.value.length === 0) {
        continue;
      }
      this.chunk = result.value;
      this.offset = 0;
    }

    return this.chunk !== undefined && this.offset < this.chunk.length;
  }

  availableLength(): number {
    return this.chunk === undefined ? 0 : this.chunk.length - this.offset;
  }

  currentView({
    length,
  }: {
    length: number,
  }): Uint8Array {
    const chunk = this.chunk;
    if (chunk === undefined || this.offset + length > chunk.length) {
      throw new Error('cmp internal error: input chunk range is unavailable');
    }
    return chunk.subarray(this.offset, this.offset + length);
  }

  advance({
    length,
  }: {
    length: number,
  }): void {
    this.offset += length;
  }

  async skip({
    count,
  }: {
    count: bigint,
  }): Promise<void> {
    let remaining = count;
    while (remaining > 0n && await this.ensureAvailable()) {
      const available = this.availableLength();
      const advance = remaining < BigInt(available)
        ? Number(remaining)
        : available;
      this.advance({ length: advance });
      remaining -= BigInt(advance);
    }
  }

  async close(): Promise<void> {
    try {
      if (!this.done) {
        try {
          await this.reader.cancel();
        } catch (originalError: unknown) {
          throw new CmpInputError({ side: this.side, originalError });
        }
      }
    } finally {
      this.reader.releaseLock();
    }
  }
}

function getComparisonLength({
  leftAvailable,
  rightAvailable,
  remainingLimit,
}: {
  leftAvailable: number,
  rightAvailable: number,
  remainingLimit: bigint | undefined,
}): number {
  const available = Math.min(leftAvailable, rightAvailable);
  if (remainingLimit === undefined || remainingLimit >= BigInt(available)) {
    return available;
  }
  return Number(remainingLimit);
}

export async function* iterateCmpDifferences({
  leftStream,
  rightStream,
  leftSkip,
  rightSkip,
  limit,
  tracking,
}: {
  leftStream: ReadableStream<Uint8Array>,
  rightStream: ReadableStream<Uint8Array>,
  leftSkip: bigint,
  rightSkip: bigint,
  limit: bigint | undefined,
  tracking: 'first-difference' | 'all-differences',
}): AsyncGenerator<CmpDifference> {
  const left = new CmpChunkCursor({ stream: leftStream, side: 'left' });
  const right = new CmpChunkCursor({ stream: rightStream, side: 'right' });
  let position = 0n;
  let line = 1n;
  let lastComparedByteWasRecordDelimiter = false;
  let remainingLimit = limit;

  try {
    await left.skip({ count: leftSkip });
    await right.skip({ count: rightSkip });

    while (remainingLimit === undefined || remainingLimit > 0n) {
      const leftAvailable = await left.ensureAvailable();
      const rightAvailable = await right.ensureAvailable();

      if (!leftAvailable || !rightAvailable) {
        if (!leftAvailable && !rightAvailable) {
          return;
        }

        yield {
          kind: 'eof',
          shorter: leftAvailable ? 'right' : 'left',
          comparedBytes: position,
          line: lastComparedByteWasRecordDelimiter && line > 1n ? line - 1n : line,
          afterRecordDelimiter: lastComparedByteWasRecordDelimiter,
        };
        return;
      }

      const comparisonLength = getComparisonLength({
        leftAvailable: left.availableLength(),
        rightAvailable: right.availableLength(),
        remainingLimit,
      });
      if (comparisonLength === 0) {
        return;
      }

      const leftBytes = left.currentView({ length: comparisonLength });
      const rightBytes = right.currentView({ length: comparisonLength });
      for (let index = 0; index < comparisonLength; index += 1) {
        const leftByte = leftBytes[index]!;
        const rightByte = rightBytes[index]!;
        if (leftByte !== rightByte) {
          yield {
            kind: 'byte',
            position: position + BigInt(index) + 1n,
            line,
            leftByte,
            rightByte,
          };
          switch (tracking) {
          case 'first-difference':
            return;
          case 'all-differences':
            break;
          default: {
            const _ex: never = tracking;
            throw new Error(`Unhandled cmp tracking mode: ${_ex}`);
          }
          }
        }

        lastComparedByteWasRecordDelimiter = leftByte === 0x0a;
        if (lastComparedByteWasRecordDelimiter) {
          line += 1n;
        }
      }

      left.advance({ length: comparisonLength });
      right.advance({ length: comparisonLength });
      position += BigInt(comparisonLength);
      if (remainingLimit !== undefined) {
        remainingLimit -= BigInt(comparisonLength);
      }
    }
  } finally {
    await Promise.all([
      left.close(),
      right.close(),
    ]);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
