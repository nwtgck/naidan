import { UNTITLED_CHAT_TITLE } from '@/models/constants'
import type { EmptyArgs } from '@/models/types'
import { searchChatTree, searchLinearBranch } from '@/utils/chat-search'
import { getChatBranchIterator } from '@/utils/chat-tree'
import type { Chat, MessageBranch } from '@/models/types'
import type { ContentMatch, FlatSearchResultItem, SearchSource } from './global-search.types'
import {
  globalSearchWorkerDisposeSessionRequestSchema,
  globalSearchWorkerPrepareSessionRequestSchema,
  globalSearchWorkerPrepareSessionResponseSchema,
  globalSearchWorkerSearchChatContentRequestSchema,
  globalSearchWorkerSearchChatContentResponseSchema,
  globalSearchWorkerSearchTitlesRequestSchema,
  globalSearchWorkerSearchTitlesResponseSchema,
  type IGlobalSearchWorker,
} from './global-search.worker.types'

const sessions = new Map<string, SearchSource>()

function createSessionId() {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `search-session-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function getKeywords({ searchQuery }: {
  searchQuery: string
}): string[] {
  return searchQuery.toLowerCase().split(/[\s\u3000]+/).filter(keyword => keyword.length > 0)
}

function getSessionSource({ sessionId }: {
  sessionId: string
}): SearchSource {
  const source = sessions.get(sessionId)
  if (!source) {
    throw new Error(`Search session not found: ${sessionId}`)
  }
  return source
}

export function createGlobalSearchWorker(_args: EmptyArgs): IGlobalSearchWorker {
  return {
    async prepareSession({ request }) {
      const validated = globalSearchWorkerPrepareSessionRequestSchema.parse(request)
      const sessionId = createSessionId()
      sessions.set(sessionId, validated.source)
      return globalSearchWorkerPrepareSessionResponseSchema.parse({ sessionId })
    },

    async searchTitles({ request }) {
      const validated = globalSearchWorkerSearchTitlesRequestSchema.parse(request)
      const source = getSessionSource({ sessionId: validated.sessionId })
      const keywords = getKeywords({ searchQuery: validated.searchQuery })
      const chatGroupIds = validated.options.chatGroupIds
      const targetChatId = validated.options.chatId
      const hasGroupFilter = !!(chatGroupIds && chatGroupIds.length > 0)

      const filteredChatGroups = targetChatId
        ? []
        : (hasGroupFilter ? source.chatGroups.filter(chatGroup => chatGroupIds.includes(chatGroup.id)) : source.chatGroups)

      const filteredChats = targetChatId
        ? source.chats.filter(({ chat }) => chat.id === targetChatId)
        : (hasGroupFilter ? source.chats.filter(({ chat }) => !!chat.groupId && chatGroupIds.includes(chat.groupId)) : source.chats)

      const flatResults: FlatSearchResultItem[] = []

      for (const chatGroup of filteredChatGroups) {
        const lowerName = chatGroup.name.toLowerCase()
        if (keywords.every(keyword => lowerName.includes(keyword))) {
          flatResults.push({
            type: 'chat_group',
            item: {
              type: 'chat_group',
              groupId: chatGroup.id,
              name: chatGroup.name,
              updatedAt: chatGroup.updatedAt,
              chatCount: chatGroup.chatCount,
              matchType: 'title',
            },
          })
        }
      }

      for (const { chat, groupName } of filteredChats) {
        const title = chat.title || UNTITLED_CHAT_TITLE
        const lowerTitle = title.toLowerCase()
        if (keywords.every(keyword => lowerTitle.includes(keyword))) {
          flatResults.push({
            type: 'chat',
            item: {
              type: 'chat',
              chatId: chat.id,
              title,
              groupId: chat.groupId,
              groupName,
              updatedAt: chat.updatedAt,
              matchType: 'title',
              titleMatch: true,
              contentMatches: [],
            },
          })
        }
      }

      return globalSearchWorkerSearchTitlesResponseSchema.parse({ flatResults })
    },

    async searchChatContent({ request }) {
      const validated = globalSearchWorkerSearchChatContentRequestSchema.parse(request)
      getSessionSource({ sessionId: validated.sessionId })

      let matches: ContentMatch[] = []

      switch (validated.scope) {
      case 'current_thread': {
        const fullChat = { ...validated.chat, ...validated.content } as unknown as Chat
        const branch = Array.from(getChatBranchIterator({ chat: fullChat }))
        matches = searchLinearBranch({
          branch,
          query: validated.searchQuery,
          chatId: validated.chat.id,
          targetLeafId: validated.content.currentLeafId,
        })
        break
      }
      case 'all': {
        const fullChat = { ...validated.chat, ...validated.content } as unknown as Chat
        const activeNodes = Array.from(getChatBranchIterator({ chat: fullChat }))
        const activeBranchIds = new Set(activeNodes.map(node => node.id))
        matches = searchChatTree({
          root: validated.content.root as unknown as MessageBranch,
          query: validated.searchQuery,
          chatId: validated.chat.id,
          activeBranchIds,
        })
        break
      }
      case 'title_only':
        matches = []
        break
      default: {
        const _exhaustiveCheck: never = validated.scope
        throw new Error(`Unhandled search scope: ${_exhaustiveCheck}`)
      }
      }

      return globalSearchWorkerSearchChatContentResponseSchema.parse({ matches })
    },

    async disposeSession({ request }) {
      const validated = globalSearchWorkerDisposeSessionRequestSchema.parse(request)
      sessions.delete(validated.sessionId)
    },
  }
}
