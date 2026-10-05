import { z } from 'zod';
import {
  modelSourceRepositorySchema as repositorySchema,
  modelSourceRevisionSchema as revisionSchema,
  modelSourceFileSchema as repositoryFileSchema,
  modelSourceSelectionSchema as selectionSchema,
} from '@/01-models/llama-cpp-browser-model-launch';
export { repositorySchema, revisionSchema, repositoryFileSchema, selectionSchema };
export type RepositoryFile = z.infer<typeof repositoryFileSchema>;
export type DownloadSelection = z.infer<typeof selectionSchema>;
export const journalSchema = z.object({ version: z.literal(1), selection: selectionSchema, bytes: z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)), complete: z.array(z.boolean()), reused: z.array(z.boolean()).optional() }).strict().refine(value => (value.reused === undefined || value.reused.length === value.selection.files.length) && value.bytes.length === value.selection.files.length && value.complete.length === value.bytes.length && value.bytes.every((bytes, index) => bytes <= value.selection.files[index]!.size && (!value.complete[index] || bytes === value.selection.files[index]!.size)));
export type DownloadJournal = z.infer<typeof journalSchema>;
export const downloadConflictSchema = z.enum(['existing-files', 'different-download', 'projector-conflict']);
export type DownloadConflict = z.infer<typeof downloadConflictSchema>;
export const beginDownloadResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), journal: journalSchema }).strict(),
  z.object({ status: z.literal('conflict'), reason: downloadConflictSchema }).strict(),
]);
export type BeginDownloadResult = z.infer<typeof beginDownloadResultSchema>;
export const sharedProjectorConflictMessage = 'Shared projector differs from the pinned source';
export const existingModelConflictMessage = 'Existing model differs from the pinned source';
export class DownloadConflictError extends Error {
  readonly reason: DownloadConflict;
  constructor({ reason }: { reason: DownloadConflict }) {
    super('Model download conflicts with existing data'); this.name = 'DownloadConflictError'; this.reason = reason;
  }
}
export const progressSchema = z.object({ phase: z.enum(['transferring', 'verifying']), currentFileIndex: z.number().int().nonnegative().optional(), processed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), completed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), total: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
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
