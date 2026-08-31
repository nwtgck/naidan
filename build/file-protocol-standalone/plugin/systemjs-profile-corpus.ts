import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OutputChunk } from 'rolldown';

type PendingCorpusEntry = Readonly<{
  fileName: string;
  name: string;
  isEntry: boolean;
  facadeModuleId: string | null;
  imports: readonly string[];
  dynamicImports: readonly string[];
  moduleIds: readonly string[];
  inputChars: number;
  inputBytes: number;
  inputSha256: string;
}>;

type CorpusEntry = PendingCorpusEntry & Readonly<{
  babelWallMs: number;
  outputBytes: number;
}>;

function corpusDirectory(): string | undefined {
  const value = process.env.NAIDAN_SYSTEMJS_PROFILE_CORPUS_DIR;
  return value === undefined || value === '' ? undefined : value;
}

function safeOutputRelativePath({ fileName }: { fileName: string }): string {
  const normalized = path.posix.normalize(fileName.replaceAll('\\', '/'));
  if (
    normalized === '..'
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Unsafe SystemJS profile corpus output file name: ${fileName}`);
  }
  return normalized;
}

function percentile({ sortedValues, quantile }: {
  sortedValues: readonly number[];
  quantile: number;
}): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * quantile) - 1),
  );
  return sortedValues[index] ?? 0;
}

export class SystemJsProfileCorpus {
  readonly #directory: string;
  readonly #entries: CorpusEntry[] = [];

  constructor({ directory }: { directory: string }) {
    this.#directory = directory;
    fs.mkdirSync(path.join(this.#directory, 'input'), { recursive: true });
  }

  captureInput({ output }: { output: OutputChunk }): PendingCorpusEntry {
    const relativePath = safeOutputRelativePath({ fileName: output.fileName });
    const outputPath = path.join(this.#directory, 'input', relativePath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, output.code);
    return {
      fileName: output.fileName,
      name: output.name,
      isEntry: output.isEntry,
      facadeModuleId: output.facadeModuleId,
      imports: [...output.imports],
      dynamicImports: [...output.dynamicImports],
      moduleIds: Object.keys(output.modules),
      inputChars: output.code.length,
      inputBytes: Buffer.byteLength(output.code),
      inputSha256: createHash('sha256').update(output.code).digest('hex'),
    };
  }

  recordResult({ input, babelWallMs, outputCode }: {
    input: PendingCorpusEntry;
    babelWallMs: number;
    outputCode: string;
  }): void {
    this.#entries.push({
      ...input,
      babelWallMs,
      outputBytes: Buffer.byteLength(outputCode),
    });
  }

  write(): void {
    const entries = [...this.#entries].sort((left, right) => left.fileName.localeCompare(right.fileName));
    const babelTimes = entries.map(entry => entry.babelWallMs).sort((left, right) => left - right);
    const totalBabelWallMs = entries.reduce((sum, entry) => sum + entry.babelWallMs, 0);
    const totalInputBytes = entries.reduce((sum, entry) => sum + entry.inputBytes, 0);
    const totalOutputBytes = entries.reduce((sum, entry) => sum + entry.outputBytes, 0);
    const corpusSha256 = createHash('sha256')
      .update(entries.map(entry => `${entry.fileName}\0${entry.inputSha256}\n`).join(''))
      .digest('hex');
    const manifest = {
      format: 'naidan-temporary-systemjs-profile-corpus-v1',
      generatedAt: new Date().toISOString(),
      notes: [
        'Temporary profiling corpus only; never make production output depend on this directory.',
        'input/ contains exact pre-SystemJS ESM chunk text as passed to Babel in this build.',
        'babelWallMs measures only the Babel transform call for each chunk; corpus file I/O is outside that timer.',
        'Use this corpus to benchmark Babel and SWC repeatedly without rebuilding real Naidan.',
      ],
      summary: {
        chunks: entries.length,
        totalInputBytes,
        totalOutputBytes,
        totalBabelWallMs,
        averageBabelWallMs: entries.length === 0 ? 0 : totalBabelWallMs / entries.length,
        p50BabelWallMs: percentile({ sortedValues: babelTimes, quantile: 0.50 }),
        p90BabelWallMs: percentile({ sortedValues: babelTimes, quantile: 0.90 }),
        p95BabelWallMs: percentile({ sortedValues: babelTimes, quantile: 0.95 }),
        p99BabelWallMs: percentile({ sortedValues: babelTimes, quantile: 0.99 }),
        maxBabelWallMs: babelTimes.at(-1) ?? 0,
        corpusSha256,
      },
      entries,
    };
    fs.writeFileSync(
      path.join(this.#directory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const rows = [
      'babel_wall_ms\tinput_bytes\toutput_bytes\tinput_chars\tis_entry\tfile_name\tinput_sha256',
      ...entries.map(entry => [
        entry.babelWallMs.toFixed(3),
        entry.inputBytes,
        entry.outputBytes,
        entry.inputChars,
        entry.isEntry ? '1' : '0',
        entry.fileName,
        entry.inputSha256,
      ].join('\t')),
      '',
    ];
    fs.writeFileSync(path.join(this.#directory, 'babel-chunks.tsv'), rows.join('\n'));
  }
}

export function createSystemJsProfileCorpus(): SystemJsProfileCorpus | undefined {
  const directory = corpusDirectory();
  return directory === undefined ? undefined : new SystemJsProfileCorpus({ directory });
}
