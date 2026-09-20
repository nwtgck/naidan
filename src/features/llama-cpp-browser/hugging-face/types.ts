import { z } from 'zod';
import { validSegment } from '@/features/llama-cpp-browser/runtime/model-directory';

export const repositorySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/).refine(value => value.split('/').every(name => validSegment({ name })));
export const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/i);
export const repositoryFileSchema = z.object({ path: z.string().refine(value => value.split('/').every(name => validSegment({ name }))).refine(value => /\.gguf$/i.test(value)), size: z.number().int().min(24).max(Number.MAX_SAFE_INTEGER) }).strict();
export const selectionSchema = z.object({ repository: repositorySchema, revision: revisionSchema, files: z.array(repositoryFileSchema).min(1).max(10000) }).strict().refine(value => new Set(value.files.map(file => file.path)).size === value.files.length).refine(value => Number.isSafeInteger(value.files.reduce((sum, file) => sum + file.size, 0)));
export type RepositoryFile = z.infer<typeof repositoryFileSchema>;
export type DownloadSelection = z.infer<typeof selectionSchema>;
export const journalSchema = z.object({ version: z.literal(1), selection: selectionSchema, bytes: z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)), complete: z.array(z.boolean()) }).strict().refine(value => value.bytes.length === value.selection.files.length && value.complete.length === value.bytes.length && value.bytes.every((bytes, index) => bytes <= value.selection.files[index]!.size && (!value.complete[index] || bytes === value.selection.files[index]!.size)));
export type DownloadJournal = z.infer<typeof journalSchema>;
export const downloadConflictSchema = z.enum(['existing-files', 'different-download']);
export type DownloadConflict = z.infer<typeof downloadConflictSchema>;
export const beginDownloadResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), journal: journalSchema }).strict(),
  z.object({ status: z.literal('conflict'), reason: downloadConflictSchema }).strict(),
]);
export type BeginDownloadResult = z.infer<typeof beginDownloadResultSchema>;
export class DownloadConflictError extends Error {
  readonly reason: DownloadConflict;
  constructor({ reason }: { reason: DownloadConflict }) {
    super('Model download conflicts with existing data'); this.name = 'DownloadConflictError'; this.reason = reason;
  }
}
export const progressSchema = z.object({ completed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), total: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export type DownloadProgress = z.infer<typeof progressSchema>;
export const pendingName = '.llama-cpp-import-pending';
export function modelName({ repository }: { repository: string }): string {
  return `hf.co/${repositorySchema.parse(repository)}`;
}
export function repositoryUrlPath({ repository }: { repository: string }): string {
  return repositorySchema.parse(repository).split('/').map(encodeURIComponent).join('/');
}
export const TEST_ONLY = {
};
