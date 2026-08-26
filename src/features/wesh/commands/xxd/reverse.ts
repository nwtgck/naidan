import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import type { WeshCommandContext, WeshFileHandle } from '@/features/wesh/types';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';
import { withXxdOperandError } from './errors';

const OUTPUT_BUFFER_SIZE = 32 * 1024;
const MAX_NORMAL_INPUT_LINE_BYTES = 1024 * 1024;
const ZERO_BLOCK = new Uint8Array(OUTPUT_BUFFER_SIZE);

function decodeHexNibble({ byte }: { byte: number }): number | undefined {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return undefined;
}

class BufferedByteOutput {
  readonly #handle: WeshFileHandle;
  readonly #seekable: boolean;
  readonly #operand: string;
  readonly #buffer = new Uint8Array(OUTPUT_BUFFER_SIZE);
  #length = 0;
  #position: number;

  constructor({
    handle,
    seekable,
    initialPosition,
    operand,
  }: {
    handle: WeshFileHandle,
    seekable: boolean,
    initialPosition: number,
    operand: string,
  }) {
    this.#handle = handle;
    this.#seekable = seekable;
    this.#operand = operand;
    this.#position = initialPosition;
  }

  get position(): number {
    return this.#position + this.#length;
  }

  async seek({ position }: { position: number }): Promise<void> {
    if (!Number.isSafeInteger(position) || position < 0) throw new Error('invalid output position');
    await this.flush();
    if (!this.#seekable && position < this.#position) throw new Error('cannot seek backwards in output');
    if (!this.#seekable && position > this.#position) {
      await this.writeZeros({ count: position - this.#position });
      await this.flush();
      return;
    }
    this.#position = position;
  }

  async #writeDirect({ bytes }: { bytes: Uint8Array }): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await withXxdOperandError({
        operand: this.#operand,
        operation: async () => this.#handle.write({
          buffer: bytes,
          offset,
          length: bytes.byteLength - offset,
          position: this.#seekable ? this.#position + offset : undefined,
        }),
      });
      if (result.bytesWritten <= 0) throw new Error('write returned no progress');
      offset += result.bytesWritten;
    }
    this.#position += bytes.byteLength;
  }

  async writeByte({ byte }: { byte: number }): Promise<void> {
    if (this.#length === this.#buffer.byteLength) await this.flush();
    this.#buffer[this.#length] = byte;
    this.#length += 1;
  }

  async writeBytes({ bytes }: { bytes: Uint8Array }): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.#length === 0 && bytes.byteLength - offset >= this.#buffer.byteLength) {
        const directLength = bytes.byteLength - offset - ((bytes.byteLength - offset) % this.#buffer.byteLength);
        await this.#writeDirect({ bytes: bytes.subarray(offset, offset + directLength) });
        offset += directLength;
        continue;
      }

      const copied = Math.min(this.#buffer.byteLength - this.#length, bytes.byteLength - offset);
      this.#buffer.set(bytes.subarray(offset, offset + copied), this.#length);
      this.#length += copied;
      offset += copied;
      if (this.#length === this.#buffer.byteLength) await this.flush();
    }
  }

  async writeZeros({ count }: { count: number }): Promise<void> {
    let remaining = count;
    while (remaining > 0) {
      const length = Math.min(remaining, ZERO_BLOCK.byteLength);
      await this.writeBytes({ bytes: ZERO_BLOCK.subarray(0, length) });
      remaining -= length;
    }
  }

  async flush(): Promise<void> {
    if (this.#length === 0) return;
    await this.#writeDirect({ bytes: this.#buffer.subarray(0, this.#length) });
    this.#length = 0;
  }
}

async function createReverseOutput({
  context,
  output,
}: {
  context: WeshCommandContext,
  output: string | undefined,
}): Promise<{ writer: BufferedByteOutput, close: () => Promise<void> }> {
  if (output === undefined || output === '-') {
    return {
      writer: new BufferedByteOutput({
        handle: context.stdout,
        seekable: false,
        initialPosition: 0,
        operand: '-',
      }),
      close: async () => undefined,
    };
  }

  const handle = await withXxdOperandError({
    operand: output,
    operation: async () => context.files.open({
      path: output,
      flags: {
        access: 'read-write',
        creation: 'if-needed',
        truncate: 'preserve',
        append: 'preserve',
      },
    }),
  });
  return {
    writer: new BufferedByteOutput({
      handle,
      seekable: true,
      initialPosition: 0,
      operand: output,
    }),
    close: async () => withXxdOperandError({
      operand: output,
      operation: async () => handle.close(),
    }),
  };
}

function isPlainWhitespace({ byte }: { byte: number }): boolean {
  return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
}

type PlainReverseState =
  | { readonly kind: 'high', invalidSeparatorSeen: boolean }
  | { readonly kind: 'low', readonly highNibble: number }
  | { readonly kind: 'scan-for-hex' }
  | { readonly kind: 'ignore-line' };

async function reversePlain({
  context,
  input,
  outputPath,
  outputOffset,
}: {
  context: WeshCommandContext,
  input: string | undefined,
  outputPath: string | undefined,
  outputOffset: number,
}): Promise<void> {
  const stream = await openCommandInputStream({ context, input });
  const { writer: output, close } = await createReverseOutput({ context, output: outputPath });
  let state: PlainReverseState = { kind: 'high', invalidSeparatorSeen: false };

  try {
    await output.seek({ position: outputOffset });
    for await (const chunk of iterateReadableStreamChunks({ stream })) {
      for (const byte of chunk) {
        if (byte === 0x00 || byte === 0x0a) {
          switch (state.kind) {
          case 'low':
            break;
          case 'high':
          case 'scan-for-hex':
          case 'ignore-line':
            state = { kind: 'high', invalidSeparatorSeen: false };
            break;
          default:
            throw new Error(`Unhandled plain reverse state: ${((state satisfies never) as { readonly kind: string }).kind}`);
          }
          continue;
        }

        const nibble = decodeHexNibble({ byte });
        switch (state.kind) {
        case 'ignore-line':
          continue;
        case 'scan-for-hex':
          if (nibble !== undefined) state = { kind: 'low', highNibble: nibble };
          continue;
        case 'low':
          if (isPlainWhitespace({ byte })) continue;
          if (nibble !== undefined) {
            await output.writeByte({ byte: (state.highNibble << 4) | nibble });
            state = { kind: 'high', invalidSeparatorSeen: false };
            continue;
          }
          state = { kind: 'scan-for-hex' };
          continue;
        case 'high':
          if (isPlainWhitespace({ byte })) continue;
          if (nibble !== undefined) {
            state = { kind: 'low', highNibble: nibble };
            continue;
          }
          if (state.invalidSeparatorSeen) {
            state = { kind: 'ignore-line' };
            continue;
          }
          state.invalidSeparatorSeen = true;
          continue;
        default:
          throw new Error(`Unhandled plain reverse state: ${((state satisfies never) as { readonly kind: string }).kind}`);
        }
      }
    }

    // xxd deliberately ignores a trailing unmatched hexadecimal nibble.
    await output.flush();
  } finally {
    await close();
  }
}

function decodeNormalLine({
  line,
}: {
  line: Uint8Array,
}): { address: number, bytes: Uint8Array } | undefined {
  let start = 0;
  while (start < line.byteLength && (line[start] === 0x20 || line[start] === 0x09)) start += 1;
  if (start === line.byteLength) return undefined;
  let colon = start;
  while (colon < line.byteLength && line[colon] !== 0x3a) colon += 1;
  if (colon === line.byteLength) {
    throw new Error(`invalid number '${new TextDecoder().decode(line.subarray(start))}'`);
  }

  let address = 0n;
  if (colon === start) throw new Error("invalid number ''");
  for (let index = start; index < colon; index += 1) {
    if (line[index] === 0x20 || line[index] === 0x09) {
      return {
        address: Number(address),
        bytes: new Uint8Array(),
      };
    }
    const nibble = decodeHexNibble({ byte: line[index]! });
    if (nibble === undefined) {
      throw new Error(`invalid number '${new TextDecoder().decode(line.subarray(start, colon))}'`);
    }
    address = (address << 4n) | BigInt(nibble);
    if (address > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('address is too large');
  }

  const decoded: number[] = [];
  let highNibble: number | undefined;
  let index = colon + 1;
  while (index < line.byteLength) {
    const byte = line[index]!;
    if (byte === 0x20 || byte === 0x09) {
      if (highNibble !== undefined) {
        highNibble = undefined;
        index += 1;
        continue;
      }
      if (
        highNibble === undefined
        && index + 1 < line.byteLength
        && (line[index + 1] === 0x20 || line[index + 1] === 0x09)
      ) {
        break;
      }
      index += 1;
      continue;
    }

    const nibble = decodeHexNibble({ byte });
    if (nibble === undefined) break;
    if (highNibble === undefined) {
      highNibble = nibble;
    } else {
      decoded.push((highNibble << 4) | nibble);
      highNibble = undefined;
    }
    index += 1;
  }

  return {
    address: Number(address),
    bytes: Uint8Array.from(decoded),
  };
}

async function reverseNormal({
  context,
  input,
  outputPath,
  outputOffset,
}: {
  context: WeshCommandContext,
  input: string | undefined,
  outputPath: string | undefined,
  outputOffset: number,
}): Promise<void> {
  const stream = await openCommandInputStream({ context, input });
  const { writer: output, close } = await createReverseOutput({ context, output: outputPath });
  let pending = new Uint8Array(256);
  let pendingLength = 0;

  const processLine = async (): Promise<void> => {
    if (pendingLength > 0 && pending[pendingLength - 1] === 0x0d) pendingLength -= 1;
    const decoded = decodeNormalLine({ line: pending.subarray(0, pendingLength) });
    pendingLength = 0;
    if (decoded === undefined) return;

    const targetPosition = decoded.address + outputOffset;
    if (!Number.isSafeInteger(targetPosition)) throw new Error('address is too large');
    await output.seek({ position: targetPosition });
    await output.writeBytes({ bytes: decoded.bytes });
  };

  try {
    for await (const chunk of iterateReadableStreamChunks({ stream })) {
      for (const byte of chunk) {
        if (byte === 0x0a) {
          await processLine();
          continue;
        }
        if (pendingLength >= MAX_NORMAL_INPUT_LINE_BYTES) {
          throw new Error('input line is too long');
        }
        if (pendingLength === pending.byteLength) {
          const expanded = new Uint8Array(Math.min(pending.byteLength * 2, MAX_NORMAL_INPUT_LINE_BYTES));
          expanded.set(pending);
          pending = expanded;
        }
        pending[pendingLength] = byte;
        pendingLength += 1;
      }
    }
    if (pendingLength > 0) await processLine();
  } finally {
    try {
      await output.flush();
    } finally {
      await close();
    }
  }
}

export async function reverseXxd({
  context,
  input,
  output,
  plain,
  outputOffset,
}: {
  context: WeshCommandContext,
  input: string | undefined,
  output: string | undefined,
  plain: boolean,
  outputOffset: number,
}): Promise<void> {
  if (plain) {
    await reversePlain({ context, input, outputPath: output, outputOffset });
    return;
  }
  await reverseNormal({ context, input, outputPath: output, outputOffset });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
