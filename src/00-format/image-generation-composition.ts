import { parseImageGenerationRawId } from './image-generation-record';
import type { ExperimentalImageGenerationCompositionDto } from './00-dto/experimental-image-generation.dto';

export function validateImageGenerationComposition({ dto, sessionId }: {
  dto: ExperimentalImageGenerationCompositionDto, sessionId: string,
}): void {
  if (dto.sessionId !== sessionId || dto.jobs.length > 128 || dto.slots.length > 128 || new Set(dto.jobs.map(job => job.id)).size !== dto.jobs.length || new Set(dto.slots.map(slot => slot.name)).size !== dto.slots.length || !Number.isSafeInteger(dto.revision) || dto.revision < 0 || !Number.isFinite(dto.updatedAt)) {
    throw new Error('Invalid image generation composition draft.');
  }
  for (const job of dto.jobs) {
    parseImageGenerationRawId({ raw: job.id });
  }
  for (const slot of dto.slots) {
    if (!slot.name.trim() || slot.name.length > 128 || /[\p{Cc}\p{Cs}]/u.test(slot.name)) {
      throw new Error('Invalid model configuration slot name.');
    }
  }
}

export const TEST_ONLY = {
};
