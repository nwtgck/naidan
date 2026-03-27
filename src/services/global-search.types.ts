import { z } from 'zod'

export const searchScopeSchema = z.enum(['all', 'title_only', 'current_thread'])

export const searchChatSummarySchema = z.object({
  id: z.string().min(1),
  title: z.union([z.string(), z.null()]),
  updatedAt: z.number(),
  groupId: z.union([z.string().min(1), z.null()]).optional(),
})

export const searchChatGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  updatedAt: z.number(),
  chatCount: z.number().int().min(0),
})

export const searchChatSourceSchema = z.object({
  chat: searchChatSummarySchema,
  groupName: z.string().optional(),
})

export const searchSourceSchema = z.object({
  chatGroups: z.array(searchChatGroupSchema),
  chats: z.array(searchChatSourceSchema),
})

export const contentMatchSchema = z.object({
  chatId: z.string().min(1),
  messageId: z.string().min(1),
  excerpt: z.string(),
  fullContent: z.string(),
  role: z.string().min(1),
  targetLeafId: z.string().min(1),
  timestamp: z.number(),
  isCurrentThread: z.boolean(),
})

export const searchChatResultSchema = z.object({
  type: z.literal('chat'),
  chatId: z.string().min(1),
  title: z.union([z.string(), z.null()]),
  groupId: z.union([z.string().min(1), z.null()]).optional(),
  groupName: z.string().optional(),
  updatedAt: z.number(),
  matchType: z.enum(['title', 'content', 'both']),
  titleMatch: z.boolean().optional(),
  contentMatches: z.array(contentMatchSchema),
})

export const searchChatGroupResultSchema = z.object({
  type: z.literal('chat_group'),
  groupId: z.string().min(1),
  name: z.string(),
  updatedAt: z.number(),
  chatCount: z.number().int().min(0),
  matchType: z.literal('title'),
})

export const searchResultItemSchema = z.union([
  searchChatResultSchema,
  searchChatGroupResultSchema,
])

export const flatSearchResultItemSchema = z.union([
  z.object({
    type: z.literal('chat'),
    item: searchChatResultSchema,
  }),
  z.object({
    type: z.literal('chat_group'),
    item: searchChatGroupResultSchema,
  }),
  z.object({
    type: z.literal('message'),
    item: contentMatchSchema,
    parentChat: searchChatResultSchema,
  }),
])

const searchMessageNodeSchema: z.ZodType<{
  id: string
  content: string | undefined
  timestamp: number
  role: string
  replies: { items: Array<{
    id: string
    content: string | undefined
    timestamp: number
    role: string
    replies: unknown
  }> }
}> = z.lazy(() => z.object({
  id: z.string().min(1),
  content: z.union([z.string(), z.undefined()]),
  timestamp: z.number(),
  role: z.string().min(1),
  replies: z.object({
    items: z.array(searchMessageNodeSchema),
  }),
}))

export const searchChatContentSchema = z.object({
  root: z.object({
    items: z.array(searchMessageNodeSchema),
  }),
  currentLeafId: z.string().min(1).optional(),
})

export const searchOptionsSchema = z.object({
  scope: searchScopeSchema,
  chatGroupIds: z.array(z.string().min(1)).optional(),
  chatId: z.string().min(1).optional(),
})

export type ContentMatch = z.infer<typeof contentMatchSchema>
export type SearchScope = z.infer<typeof searchScopeSchema>
export type SearchChatSummary = z.infer<typeof searchChatSummarySchema>
export type SearchChatGroup = z.infer<typeof searchChatGroupSchema>
export type SearchChatSource = z.infer<typeof searchChatSourceSchema>
export type SearchSource = z.infer<typeof searchSourceSchema>
export type SearchChatContent = z.infer<typeof searchChatContentSchema>
export type SearchOptions = z.infer<typeof searchOptionsSchema>
export type SearchResultItem = z.infer<typeof searchResultItemSchema>
export type FlatSearchResultItem = z.infer<typeof flatSearchResultItemSchema>
