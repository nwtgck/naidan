import type { ZodType } from 'zod';
import {
  OpfsJsonSyntaxError,
  readJsonValueIfPresent,
  writeJsonFile,
} from './opfs-json-file';

export interface SequencedValue {
  readonly formatVersion: number,
  readonly sequence: number,
}

export class DualSlotJsonStore<T extends SequencedValue> {
  constructor({
    directory,
    filePrefix,
    schema,
  }: {
    directory: FileSystemDirectoryHandle,
    filePrefix: string,
    schema: ZodType<T>,
  }) {
    this.directory = directory;
    this.filePrefix = filePrefix;
    this.schema = schema;
  }

  private readonly directory: FileSystemDirectoryHandle;
  private readonly filePrefix: string;
  private readonly schema: ZodType<T>;

  async read(): Promise<T | undefined> {
    const candidates: Array<{
      readonly sequence: number,
      readonly value: T | undefined,
      readonly parseError: unknown | undefined,
    }> = [];

    for (const slot of [0, 1] as const) {
      let raw: unknown;
      try {
        raw = await readJsonValueIfPresent({
          directory: this.directory,
          name: `${this.filePrefix}-${slot}.json`,
        });
      } catch (error) {
        if (error instanceof OpfsJsonSyntaxError) {
          // A partially written JSON document is not a committed slot. The
          // other slot remains eligible, but I/O and permission failures must
          // not be mislabeled as ordinary slot corruption.
          continue;
        }
        throw error;
      }
      if (raw === undefined || typeof raw !== 'object' || raw === null) {
        continue;
      }
      const sequence = (raw as { sequence?: unknown }).sequence;
      const formatVersion = (raw as { formatVersion?: unknown }).formatVersion;
      if (
        !Number.isSafeInteger(sequence)
        || (sequence as number) < 0
        || !Number.isSafeInteger(formatVersion)
        || (formatVersion as number) < 1
      ) {
        continue;
      }
      const parsed = this.schema.safeParse(raw);
      candidates.push({
        sequence: sequence as number,
        value: parsed.success ? parsed.data : undefined,
        parseError: parsed.success ? undefined : parsed.error,
      });
    }

    candidates.sort((left, right) => right.sequence - left.sequence);
    if (candidates.length >= 2 && candidates[0]?.sequence === candidates[1]?.sequence) {
      throw new Error(`Dual-slot ${this.filePrefix} values have the same sequence`);
    }
    const newest = candidates[0];
    if (newest === undefined) {
      return undefined;
    }
    if (newest.value === undefined) {
      throw new Error(
        `Newest dual-slot ${this.filePrefix} value is not supported or is structurally invalid`,
        { cause: newest.parseError },
      );
    }
    return newest.value;
  }

  async write({ value }: { value: T }): Promise<void> {
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) {
      throw new Error('Dual-slot sequence must be a non-negative safe integer');
    }
    const slot = value.sequence % 2;
    await writeJsonFile({
      directory: this.directory,
      name: `${this.filePrefix}-${slot}.json`,
      value,
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
