import { z } from 'zod'

export const advancedTextEditorV3MatchSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
})

export const advancedTextEditorV3CaseSensitiveSchema = z.union([
  z.literal('case-sensitive'),
  z.literal('case-insensitive'),
])

export const advancedTextEditorV3RegexModeSchema = z.union([
  z.literal('regex-on'),
  z.literal('regex-off'),
])

export const advancedTextEditorV3SearchTextRequestSchema = z.object({
  text: z.string(),
  query: z.string(),
  caseSensitive: advancedTextEditorV3CaseSensitiveSchema,
  useRegex: advancedTextEditorV3RegexModeSchema,
})

export const advancedTextEditorV3SearchTextResponseSchema = z.object({
  matches: z.array(advancedTextEditorV3MatchSchema),
  isValidRegex: z.boolean(),
})

export const advancedTextEditorV3ReplaceAllRequestSchema = z.object({
  text: z.string(),
  query: z.string(),
  replacement: z.string(),
  caseSensitive: advancedTextEditorV3CaseSensitiveSchema,
  useRegex: advancedTextEditorV3RegexModeSchema,
})

export const advancedTextEditorV3ReplaceAllResponseSchema = z.object({
  text: z.string(),
  matches: z.array(advancedTextEditorV3MatchSchema),
  isValidRegex: z.boolean(),
})

export const advancedTextEditorV3ReplaceSingleRequestSchema = z.object({
  text: z.string(),
  query: z.string(),
  replacement: z.string(),
  caseSensitive: advancedTextEditorV3CaseSensitiveSchema,
  useRegex: advancedTextEditorV3RegexModeSchema,
  selectionStart: z.number().int().nonnegative(),
  selectionEnd: z.number().int().nonnegative(),
})

export const advancedTextEditorV3ReplaceSingleResponseSchema = z.object({
  didReplace: z.boolean(),
  text: z.string(),
  replacementStart: z.union([z.number().int().nonnegative(), z.undefined()]),
  replacementEnd: z.union([z.number().int().nonnegative(), z.undefined()]),
  matches: z.array(advancedTextEditorV3MatchSchema),
  isValidRegex: z.boolean(),
})

export const advancedTextEditorV3PrepareMultiEditRequestSchema = z.object({
  text: z.string(),
  selectionStart: z.number().int().nonnegative(),
  selectionEnd: z.number().int().nonnegative(),
})

export const advancedTextEditorV3PrepareMultiEditResponseSchema = z.object({
  selection: z.union([z.string().min(1), z.undefined()]),
  selectionStart: z.union([z.number().int().nonnegative(), z.undefined()]),
  selectionEnd: z.union([z.number().int().nonnegative(), z.undefined()]),
  matchStarts: z.array(z.number().int().nonnegative()),
})

export const advancedTextEditorV3ApplyMultiEditRequestSchema = z.object({
  text: z.string(),
  target: z.string().min(1),
  replacement: z.string(),
})

export const advancedTextEditorV3ApplyMultiEditResponseSchema = z.object({
  text: z.string(),
})

export type AdvancedTextEditorV3Match = z.infer<typeof advancedTextEditorV3MatchSchema>
export type AdvancedTextEditorV3SearchTextRequest = z.infer<typeof advancedTextEditorV3SearchTextRequestSchema>
export type AdvancedTextEditorV3SearchTextResponse = z.infer<typeof advancedTextEditorV3SearchTextResponseSchema>
export type AdvancedTextEditorV3ReplaceAllRequest = z.infer<typeof advancedTextEditorV3ReplaceAllRequestSchema>
export type AdvancedTextEditorV3ReplaceAllResponse = z.infer<typeof advancedTextEditorV3ReplaceAllResponseSchema>
export type AdvancedTextEditorV3ReplaceSingleRequest = z.infer<typeof advancedTextEditorV3ReplaceSingleRequestSchema>
export type AdvancedTextEditorV3ReplaceSingleResponse = z.infer<typeof advancedTextEditorV3ReplaceSingleResponseSchema>
export type AdvancedTextEditorV3PrepareMultiEditRequest = z.infer<typeof advancedTextEditorV3PrepareMultiEditRequestSchema>
export type AdvancedTextEditorV3PrepareMultiEditResponse = z.infer<typeof advancedTextEditorV3PrepareMultiEditResponseSchema>
export type AdvancedTextEditorV3ApplyMultiEditRequest = z.infer<typeof advancedTextEditorV3ApplyMultiEditRequestSchema>
export type AdvancedTextEditorV3ApplyMultiEditResponse = z.infer<typeof advancedTextEditorV3ApplyMultiEditResponseSchema>

export interface IAdvancedTextEditorV3Worker {
  searchText({ request }: { request: AdvancedTextEditorV3SearchTextRequest }): Promise<AdvancedTextEditorV3SearchTextResponse>
  replaceAll({ request }: { request: AdvancedTextEditorV3ReplaceAllRequest }): Promise<AdvancedTextEditorV3ReplaceAllResponse>
  replaceSingle({ request }: { request: AdvancedTextEditorV3ReplaceSingleRequest }): Promise<AdvancedTextEditorV3ReplaceSingleResponse>
  prepareMultiEdit({ request }: { request: AdvancedTextEditorV3PrepareMultiEditRequest }): Promise<AdvancedTextEditorV3PrepareMultiEditResponse>
  applyMultiEdit({ request }: { request: AdvancedTextEditorV3ApplyMultiEditRequest }): Promise<AdvancedTextEditorV3ApplyMultiEditResponse>
}

export interface AdvancedTextEditorV3WorkerClient {
  searchText({ request }: { request: AdvancedTextEditorV3SearchTextRequest }): Promise<AdvancedTextEditorV3SearchTextResponse>
  replaceAll({ request }: { request: AdvancedTextEditorV3ReplaceAllRequest }): Promise<AdvancedTextEditorV3ReplaceAllResponse>
  replaceSingle({ request }: { request: AdvancedTextEditorV3ReplaceSingleRequest }): Promise<AdvancedTextEditorV3ReplaceSingleResponse>
  prepareMultiEdit({ request }: { request: AdvancedTextEditorV3PrepareMultiEditRequest }): Promise<AdvancedTextEditorV3PrepareMultiEditResponse>
  applyMultiEdit({ request }: { request: AdvancedTextEditorV3ApplyMultiEditRequest }): Promise<AdvancedTextEditorV3ApplyMultiEditResponse>
  dispose(): Promise<void>
}
