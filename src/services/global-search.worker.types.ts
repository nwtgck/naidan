import { z } from 'zod'
import type { EmptyArgs } from '@/models/types'
import {
  flatSearchResultItemSchema,
  searchChatContentSchema,
  searchOptionsSchema,
  searchScopeSchema,
  searchSourceSchema,
  searchChatSummarySchema,
  contentMatchSchema,
} from './global-search.types'

export const globalSearchWorkerPrepareSessionRequestSchema = z.object({
  source: searchSourceSchema,
})

export const globalSearchWorkerPrepareSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
})

export const globalSearchWorkerSearchTitlesRequestSchema = z.object({
  sessionId: z.string().min(1),
  searchQuery: z.string(),
  options: searchOptionsSchema,
})

export const globalSearchWorkerSearchTitlesResponseSchema = z.object({
  flatResults: z.array(flatSearchResultItemSchema),
})

export const globalSearchWorkerSearchChatContentRequestSchema = z.object({
  sessionId: z.string().min(1),
  searchQuery: z.string(),
  scope: searchScopeSchema,
  chat: searchChatSummarySchema,
  groupName: z.union([z.string(), z.undefined()]),
  content: searchChatContentSchema,
})

export const globalSearchWorkerSearchChatContentResponseSchema = z.object({
  matches: z.array(contentMatchSchema),
})

export const globalSearchWorkerDisposeSessionRequestSchema = z.object({
  sessionId: z.string().min(1),
})

export type GlobalSearchWorkerPrepareSessionRequest = z.infer<typeof globalSearchWorkerPrepareSessionRequestSchema>
export type GlobalSearchWorkerPrepareSessionResponse = z.infer<typeof globalSearchWorkerPrepareSessionResponseSchema>
export type GlobalSearchWorkerSearchTitlesRequest = z.infer<typeof globalSearchWorkerSearchTitlesRequestSchema>
export type GlobalSearchWorkerSearchTitlesResponse = z.infer<typeof globalSearchWorkerSearchTitlesResponseSchema>
export type GlobalSearchWorkerSearchChatContentRequest = z.infer<typeof globalSearchWorkerSearchChatContentRequestSchema>
export type GlobalSearchWorkerSearchChatContentResponse = z.infer<typeof globalSearchWorkerSearchChatContentResponseSchema>
export type GlobalSearchWorkerDisposeSessionRequest = z.infer<typeof globalSearchWorkerDisposeSessionRequestSchema>

export interface IGlobalSearchWorker {
  prepareSession({ request }: { request: GlobalSearchWorkerPrepareSessionRequest }): Promise<GlobalSearchWorkerPrepareSessionResponse>
  searchTitles({ request }: { request: GlobalSearchWorkerSearchTitlesRequest }): Promise<GlobalSearchWorkerSearchTitlesResponse>
  searchChatContent({ request }: { request: GlobalSearchWorkerSearchChatContentRequest }): Promise<GlobalSearchWorkerSearchChatContentResponse>
  disposeSession({ request }: { request: GlobalSearchWorkerDisposeSessionRequest }): Promise<void>
}

export interface GlobalSearchWorkerClient {
  prepareSession({ request }: { request: GlobalSearchWorkerPrepareSessionRequest }): Promise<GlobalSearchWorkerPrepareSessionResponse>
  searchTitles({ request }: { request: GlobalSearchWorkerSearchTitlesRequest }): Promise<GlobalSearchWorkerSearchTitlesResponse>
  searchChatContent({ request }: { request: GlobalSearchWorkerSearchChatContentRequest }): Promise<GlobalSearchWorkerSearchChatContentResponse>
  disposeSession({ request }: { request: GlobalSearchWorkerDisposeSessionRequest }): Promise<void>
  dispose(_args: EmptyArgs): Promise<void>
}
