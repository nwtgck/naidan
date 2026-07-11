import type { ZodType } from 'zod';
import { readJsonFileIfPresent, writeJsonFile } from './opfs-json-file';

export interface SequencedValue {
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
    const values: T[] = [];
    for (const slot of [0, 1] as const) {
      try {
        const value = await readJsonFileIfPresent({
          directory: this.directory,
          name: `${this.filePrefix}-${slot}.json`,
          schema: this.schema,
        });
        if (value !== undefined) {
          values.push(value);
        }
      } catch {
        // The other slot may still be valid after an interrupted write.
      }
    }

    values.sort((left, right) => right.sequence - left.sequence);
    if (values.length === 2 && values[0]?.sequence === values[1]?.sequence) {
      throw new Error(
        `Dual-slot ${this.filePrefix} values have the same sequence`,
      );
    }
    return values[0];
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
