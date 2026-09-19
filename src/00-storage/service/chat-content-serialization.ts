import type { ChatContent } from '@/01-models/types';
import { ChatContentSchemaDto } from '@/00-storage/00-dto/dto';
import { chatContentToDomain, chatContentToDto } from '@/00-storage/mapper/mappers';

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
  const dto = chatContentToDto({ domain: content });
  // Production storage validates the DTO before writing the JSON payload. Keep
  // the investigation round trip on the same serialization boundary.
  ChatContentSchemaDto.parse(dto);
  const serialized = JSON.stringify(dto);
  const restored = chatContentToDomain({
    dto: ChatContentSchemaDto.parse(JSON.parse(serialized) as unknown),
  });
  return { restored, serialized };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
