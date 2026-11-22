import { z } from 'zod';

const offsetSchema = z.number().int().nonnegative();
const spanSchema = z.object({ start: offsetSchema, end: offsetSchema });
const matchSchema = spanSchema.extend({ index: offsetSchema });
const editSchema = spanSchema.extend({ text: z.string() });
const versionSchema = z.object({ version: offsetSchema });

export const editorDocumentSnapshotSchema = versionSchema.extend({ text: z.string() });
export const editorDocumentChangesSchema = z.object({
  baseVersion: offsetSchema,
  version: offsetSchema,
  edits: z.array(editSchema).readonly(),
});
const searchOptionsSchema = z.object({
  query: z.string(),
  caseSensitivity: z.enum(['case-sensitive', 'case-insensitive']),
  mode: z.enum(['literal', 'regex']),
});
export const editorSearchRequestSchema = versionSchema.extend({
  options: searchOptionsSchema,
  visible: spanSchema,
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('offset'), offset: offsetSchema }),
    z.object({ kind: z.literal('index'), index: z.number().int() }),
  ]),
});
export const editorSearchResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('matches'),
    count: offsetSchema,
    active: matchSchema.optional(),
    highlights: z.array(matchSchema),
  }),
  z.object({ kind: z.enum(['invalid-regex', 'unavailable']) }),
]);
export const editorReplaceRequestSchema = versionSchema.extend({
  options: searchOptionsSchema,
  replacement: z.string(),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('all') }),
    z.object({ kind: z.literal('match'), index: offsetSchema }),
  ]),
});
export const editorReplaceResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('edits'), edits: z.array(editSchema) }),
  z.object({ kind: z.enum(['invalid-regex', 'unavailable', 'too-large']) }),
]);

export type EditorSearchOptions = z.infer<typeof searchOptionsSchema>;
export type EditorSearchMatch = z.infer<typeof matchSchema>;
export type EditorDocumentSnapshot = z.infer<typeof editorDocumentSnapshotSchema>;
export type EditorDocumentChanges = z.infer<typeof editorDocumentChangesSchema>;
export type EditorSearchRequest = z.infer<typeof editorSearchRequestSchema>;
export type EditorSearchResponse = z.infer<typeof editorSearchResponseSchema>;
export type EditorReplaceRequest = z.infer<typeof editorReplaceRequestSchema>;
export type EditorReplaceResponse = z.infer<typeof editorReplaceResponseSchema>;

export interface EditorSearchWorker {
  setDocument({ snapshot }: { snapshot: EditorDocumentSnapshot }): Promise<void>,
  applyChanges({ changes }: { changes: EditorDocumentChanges }): Promise<void>,
  search({ request }: { request: EditorSearchRequest }): Promise<EditorSearchResponse>,
  replace({ request }: { request: EditorReplaceRequest }): Promise<EditorReplaceResponse>,
}

export interface EditorSearchClient extends EditorSearchWorker {
  dispose(): Promise<void>,
}

export const TEST_ONLY = {
};
