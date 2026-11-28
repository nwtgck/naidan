import { MigrationStateDtoSchema, type MigrationStateDto } from '@/00-format/00-dto/dto';
import type { FileLocation, ReadFileText, WriteFileText } from '@/00-format/file-record';

export function migrationStateFile({ file }: { file: FileLocation }) {
  return {
    path: file.path,
    async read({ readText }: { readText: ReadFileText }) {
      let state: MigrationStateDto = { completedMigrations: [] };
      try {
        const text = await readText({ file });
        if (text !== undefined) {
          state = MigrationStateDtoSchema.parse(JSON.parse(text));
        }
      } catch {
        // A failed read leaves migrations eligible to retry.
      }
      return {
        hasCompleted({ name }: { name: string }): boolean {
          return state.completedMigrations.some(migration => migration.name === name);
        },
        async markCompleted({ name, completedAt, writeText }: {
          name: string, completedAt: number, writeText: WriteFileText,
        }): Promise<void> {
          state.completedMigrations.push({ name, completedAt });
          await writeText({ file, text: JSON.stringify(state) });
        },
      };
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
