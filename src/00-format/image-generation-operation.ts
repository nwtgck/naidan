import { parseImageGenerationRawId } from './image-generation-record';
import { idToRaw, toImageGenerationOperationId, toImageGenerationRunId, toImageGenerationSessionId } from '@/01-models/ids';
import type { ImageGenerationOperation, ImageGenerationRunSummary } from '@/01-models/image-generation';
import type { ExperimentalImageGenerationOperationDto } from './00-dto/experimental-image-generation.dto';

type LegacyRun = Pick<ImageGenerationRunSummary, 'id' | 'operationId' | 'createdAt'>;

export function isLegacyImageGenerationRun({ run }: { run: Pick<LegacyRun, 'operationId'> }): boolean {
  return run.operationId === undefined;
}

/** An older run owns an operation with the same ID, without a parent record. */
export function legacyRunToOperation({ run, sessionId }: {
  run: LegacyRun | undefined, sessionId: ImageGenerationOperation['sessionId'],
}): ImageGenerationOperation | undefined {
  if (run === undefined || !isLegacyImageGenerationRun({ run })) {
    return undefined;
  }
  return { id: toImageGenerationOperationId({ raw: idToRaw({ id: run.id }) }), sessionId, createdAt: run.createdAt, runIds: [run.id] };
}

export function imageGenerationOperationToDto({ operation }: { operation: ImageGenerationOperation }): ExperimentalImageGenerationOperationDto {
  return { ...operation, version: 1, id: idToRaw({ id: operation.id }), sessionId: idToRaw({ id: operation.sessionId }), runIds: operation.runIds.map(id => idToRaw({ id })) };
}

export function imageGenerationOperationToDomain({ dto }: {
  dto: ExperimentalImageGenerationOperationDto,
}): ImageGenerationOperation {
  const { version: _version, id, sessionId, runIds, ...rest } = dto;
  return { ...rest, id: toImageGenerationOperationId({ raw: id }), sessionId: toImageGenerationSessionId({ raw: sessionId }), runIds: runIds.map(raw => toImageGenerationRunId({ raw })) };
}

export function validateImageGenerationOperation({ record, sessionId }: {
  record: ExperimentalImageGenerationOperationDto, sessionId: string,
}): void {
  parseImageGenerationRawId({ raw: record.id });
  if (record.sessionId !== sessionId || !Number.isFinite(record.createdAt) || !record.runIds.length || record.runIds.length > 128 || new Set(record.runIds).size !== record.runIds.length) {
    throw new Error('Invalid image generation operation membership.');
  }
  for (const id of record.runIds) {
    parseImageGenerationRawId({ raw: id });
  }
}

export const TEST_ONLY = {
};
