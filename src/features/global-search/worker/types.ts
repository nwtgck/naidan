import { z } from 'zod';
import type { StorageType } from '@/01-models/types';

import {
  searchOptionsSchema,
  searchScopeSchema,
  contentMatchSchema,
} from '@/features/global-search/types';
import type { GlobalSearchRemoteContentReader } from './content-reader';

export const globalSearchWorkerSearchChatContentRequestSchema = z.object({
  storageType: z.enum(['local', 'opfs', 'memory']),
  searchQuery: z.string(),
  scope: searchScopeSchema,
  roleFilter: searchOptionsSchema.shape.roleFilter,
  chatId: z.string().min(1),
});

export const globalSearchWorkerSearchChatContentResponseSchema = z.object({
  matches: z.array(contentMatchSchema),
});

export type GlobalSearchWorkerRemoteSearchChatContentRequest =
  z.infer<typeof globalSearchWorkerSearchChatContentRequestSchema>;
export type GlobalSearchWorkerSearchChatContentRequest =
  Omit<GlobalSearchWorkerRemoteSearchChatContentRequest, 'storageType'>;
export type GlobalSearchWorkerSearchChatContentResponse =
  z.infer<typeof globalSearchWorkerSearchChatContentResponseSchema>;

export interface IGlobalSearchWorker {
  // Comlink boundary: the proxied reader must be a top-level positional argument.
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy arguments cannot be nested in the request object.
  configureStorage(
    storageType: StorageType,
    remoteContentReader?: GlobalSearchRemoteContentReader,
  ): Promise<void>;

  searchChatContent({ request }: {
    request: GlobalSearchWorkerRemoteSearchChatContentRequest,
  }): Promise<GlobalSearchWorkerSearchChatContentResponse>;
}

export interface GlobalSearchWorkerClient {
  searchChatContent({ request }: {
    request: GlobalSearchWorkerSearchChatContentRequest,
  }): Promise<GlobalSearchWorkerSearchChatContentResponse>;

  dispose(): Promise<void>;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
