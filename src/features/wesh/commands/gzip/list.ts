import type { WeshCommandContext } from '@/features/wesh/types';
import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import {
  consumeGzipInputWithMetrics,
  peekGzipInput,
} from '@/features/wesh/commands/_shared/gzip-decompression';
import { getPathErrorReason } from '@/features/wesh/commands/_shared/path-errors';

const GZIP_FOOTER_BYTES = 8;
const LIST_HEADER = `${'compressed'.padStart(19)}${'uncompressed'.padStart(20)}${'ratio'.padStart(7)} uncompressed_name\n`;

type GzipListRow = {
  readonly compressedBytes: number,
  readonly uncompressedBytes: number,
  readonly headerBytes: number,
  readonly name: string,
};

function formatRatio({
  compressedBytes,
  uncompressedBytes,
  headerBytes,
}: {
  compressedBytes: number,
  uncompressedBytes: number,
  headerBytes: number,
}): string {
  if (uncompressedBytes === 0) return '0.0%';
  const payloadBytes = Math.max(
    0,
    compressedBytes - headerBytes - GZIP_FOOTER_BYTES,
  );
  const percentage = 100 * (uncompressedBytes - payloadBytes) / uncompressedBytes;
  return `${percentage.toFixed(1)}%`;
}

function formatListRow({
  row,
}: {
  row: GzipListRow,
}): string {
  return `${String(row.compressedBytes).padStart(19)}${String(row.uncompressedBytes).padStart(20)}${formatRatio({
    compressedBytes: row.compressedBytes,
    uncompressedBytes: row.uncompressedBytes,
    headerBytes: row.headerBytes,
  }).padStart(7)} ${row.name}\n`;
}

function deriveUncompressedName({
  input,
  suffix,
}: {
  input: string,
  suffix: string,
}): string {
  if (input === '-') return 'stdout';
  if (input.endsWith('.gz')) return input.slice(0, -3);
  if (suffix.length > 0 && input.endsWith(suffix)) {
    return input.slice(0, -suffix.length);
  }
  return input;
}

export async function executeGzipListCommand({
  context,
  inputs,
  quiet,
  suffix,
}: {
  context: WeshCommandContext,
  inputs: readonly string[],
  quiet: boolean,
  suffix: string,
}): Promise<{ readonly exitCode: number }> {
  const text = context.text();
  const rows: GzipListRow[] = [];
  let exitCode = 0;

  for (const input of inputs) {
    try {
      const peeked = await peekGzipInput({
        source: await openCommandInputStream({ context, input }),
      });
      if (!peeked.isGzip) {
        const displayInput = input === '-' ? 'stdin' : input;
        await text.error({ text: `\ngzip: ${displayInput}: not in gzip format\n` });
        exitCode = 1;
        continue;
      }

      const metrics = await consumeGzipInputWithMetrics({
        source: peeked.stream,
        output: undefined,
      });
      switch (metrics.result) {
      case 'success': {
        if (metrics.headerBytes === undefined) {
          await text.error({ text: `\ngzip: ${input}: invalid gzip header\n` });
          exitCode = 1;
          break;
        }
        rows.push({
          compressedBytes: metrics.compressedBytes,
          uncompressedBytes: metrics.uncompressedBytes,
          headerBytes: metrics.headerBytes,
          name: deriveUncompressedName({ input, suffix }),
        });
        break;
      }
      case 'trailing_garbage':
        if (!quiet) {
          await text.error({
            text: `\ngzip: ${input}: decompression OK, trailing garbage ignored\n`,
          });
        }
        exitCode = Math.max(exitCode, 2);
        break;
      case 'invalid':
        await text.error({ text: `\ngzip: ${input}: invalid compressed data\n` });
        exitCode = 1;
        break;
      default: {
        const _ex: never = metrics.result;
        throw new Error(`Unhandled gzip list decompression result: ${_ex}`);
      }
      }
    } catch (error: unknown) {
      const message = getPathErrorReason({ error })
        ?? (error instanceof Error ? error.message : String(error));
      await text.error({ text: `gzip: ${input}: ${message}\n` });
      exitCode = 1;
    }
  }

  if (rows.length === 0) return { exitCode };

  await text.print({ text: LIST_HEADER });
  for (const row of rows) {
    await text.print({ text: formatListRow({ row }) });
  }

  if (inputs.length > 1) {
    const last = rows.at(-1)!;
    const totals: GzipListRow = {
      compressedBytes: rows.reduce((sum, row) => sum + row.compressedBytes, 0),
      uncompressedBytes: rows.reduce((sum, row) => sum + row.uncompressedBytes, 0),
      headerBytes: last.headerBytes,
      name: '(totals)',
    };
    await text.print({ text: formatListRow({ row: totals }) });
  }

  return { exitCode };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  deriveUncompressedName,
  formatListRow,
  formatRatio,
};
