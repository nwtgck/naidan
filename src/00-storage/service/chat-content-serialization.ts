import type { ChatContent } from '@/01-models/types';
import { opfsFormat } from '@/00-format/01-layout/layout';

/**
 * Exercises Naidan's production ChatContent persistence serialization contract
 * without reading from or writing to a storage provider.
 */
export function roundTripChatContentPersistenceSerialization({
  content,
}: {
  content: ChatContent,
}): {
  restored: ChatContent,
  serialized: string,
} {
  return opfsFormat.storage.chatContents.inspectRoundTrip({ content });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
