import type { ImageGenerationModelFile, ImageGenerationRecord, ImageGenerationSummary } from '@/01-models/image-generation-history';
import { idToRaw, toBinaryObjectId, toHostModelDirectoryId, toImageGenerationId } from '@/01-models/ids';
import { exactObject } from '@/utils/exact-object';
import type { ExperimentalImageGenerationDto, ExperimentalImageGenerationSummaryDto } from '@/00-storage/00-dto/experimental.dto';

type ModelFileDto = ExperimentalImageGenerationDto['request']['models'][number]['file'];

function fileToDomain({ file }: { file: ModelFileDto }): ImageGenerationModelFile {
  switch (file.type) {
  case 'file': return exactObject<Extract<ImageGenerationModelFile, { type: 'file' }>>()({ ...file });
  case 'opfs': return exactObject<Extract<ImageGenerationModelFile, { type: 'opfs' }>>()({ ...file });
  case 'host': return exactObject<Extract<ImageGenerationModelFile, { type: 'host' }>>()({ ...file, directoryId: toHostModelDirectoryId({ raw: file.directoryId }) });
  default: { const exhaustive: never = file; throw new Error(String(exhaustive)); }
  }
}

function fileToDto({ file }: { file: ImageGenerationModelFile }): ModelFileDto {
  switch (file.type) {
  case 'file': return exactObject<Extract<ModelFileDto, { type: 'file' }>>()({ ...file });
  case 'opfs': return exactObject<Extract<ModelFileDto, { type: 'opfs' }>>()({ ...file });
  case 'host': return exactObject<Extract<ModelFileDto, { type: 'host' }>>()({ ...file, directoryId: idToRaw({ id: file.directoryId }) });
  default: { const exhaustive: never = file; throw new Error(String(exhaustive)); }
  }
}

export function imageGenerationRequestToDomain({ request }: { request: ExperimentalImageGenerationDto['request'] }): ImageGenerationRecord['request'] {
  const { models, loras, imageInputs, parameters, preview, runtime, ...requestMetadata } = request;
  const { initImage, referenceImages, ...inputMetadata } = imageInputs;
  return exactObject<ImageGenerationRecord['request']>()({
    ...requestMetadata,
    parameters: exactObject<ImageGenerationRecord['request']['parameters']>()({ ...parameters }),
    preview: exactObject<ImageGenerationRecord['request']['preview']>()({ ...preview }),
    runtime: exactObject<ImageGenerationRecord['request']['runtime']>()({ ...runtime }),
    models: models.map(({ file, companions, ...model }) => exactObject<ImageGenerationRecord['request']['models'][number]>()({
      ...model, file: fileToDomain({ file }), companions: companions.map(({ file, ...companion }) => exactObject<ImageGenerationRecord['request']['models'][number]['companions'][number]>()({ ...companion, file: fileToDomain({ file }) })),
    })),
    loras: loras.map(({ file, ...lora }) => exactObject<ImageGenerationRecord['request']['loras'][number]>()({ ...lora, file: fileToDomain({ file }) })),
    imageInputs: exactObject<ImageGenerationRecord['request']['imageInputs']>()({
      ...inputMetadata,
      initImage: initImage && exactObject<NonNullable<ImageGenerationRecord['request']['imageInputs']['initImage']>>()({ ...initImage, binaryObjectId: toBinaryObjectId({ raw: initImage.binaryObjectId }) }),
      referenceImages: referenceImages.map(image => exactObject<ImageGenerationRecord['request']['imageInputs']['referenceImages'][number]>()({ ...image, binaryObjectId: toBinaryObjectId({ raw: image.binaryObjectId }) })),
    }),
  });
}

export function imageGenerationRequestToDto({ request }: { request: ImageGenerationRecord['request'] }): ExperimentalImageGenerationDto['request'] {
  const { models, loras, imageInputs, parameters, preview, runtime, ...requestMetadata } = request;
  const { initImage, referenceImages, ...inputMetadata } = imageInputs;
  return exactObject<ExperimentalImageGenerationDto['request']>()({
    ...requestMetadata,
    parameters: exactObject<ExperimentalImageGenerationDto['request']['parameters']>()({ ...parameters }),
    preview: exactObject<ExperimentalImageGenerationDto['request']['preview']>()({ ...preview }),
    runtime: exactObject<ExperimentalImageGenerationDto['request']['runtime']>()({ ...runtime }),
    models: models.map(({ file, companions, ...model }) => exactObject<ExperimentalImageGenerationDto['request']['models'][number]>()({
      ...model, file: fileToDto({ file }), companions: companions.map(({ file, ...companion }) => exactObject<ExperimentalImageGenerationDto['request']['models'][number]['companions'][number]>()({ ...companion, file: fileToDto({ file }) })),
    })),
    loras: loras.map(({ file, ...lora }) => exactObject<ExperimentalImageGenerationDto['request']['loras'][number]>()({ ...lora, file: fileToDto({ file }) })),
    imageInputs: exactObject<ExperimentalImageGenerationDto['request']['imageInputs']>()({
      ...inputMetadata,
      initImage: initImage && exactObject<NonNullable<ExperimentalImageGenerationDto['request']['imageInputs']['initImage']>>()({ ...initImage, binaryObjectId: idToRaw({ id: initImage.binaryObjectId }) }),
      referenceImages: referenceImages.map(image => exactObject<ExperimentalImageGenerationDto['request']['imageInputs']['referenceImages'][number]>()({ ...image, binaryObjectId: idToRaw({ id: image.binaryObjectId }) })),
    }),
  });
}

export function imageGenerationToDomain({ dto }: { dto: ExperimentalImageGenerationDto }): ImageGenerationRecord {
  const { id, request, result, previews, ...metadata } = dto;
  return exactObject<ImageGenerationRecord>()({
    ...metadata, id: toImageGenerationId({ raw: id }), request: imageGenerationRequestToDomain({ request }),
    result: exactObject<ImageGenerationRecord['result']>()({ ...result, binaryObjectId: toBinaryObjectId({ raw: result.binaryObjectId }) }),
    previews: previews.map(preview => exactObject<ImageGenerationRecord['previews'][number]>()({ ...preview, binaryObjectId: toBinaryObjectId({ raw: preview.binaryObjectId }) })),
  });
}

export function imageGenerationToDto({ record }: { record: ImageGenerationRecord }): ExperimentalImageGenerationDto {
  const { id, request, result, previews, ...metadata } = record;
  return exactObject<ExperimentalImageGenerationDto>()({
    ...metadata, id: idToRaw({ id }), request: imageGenerationRequestToDto({ request }),
    result: exactObject<ExperimentalImageGenerationDto['result']>()({ ...result, binaryObjectId: idToRaw({ id: result.binaryObjectId }) }),
    previews: previews.map(preview => exactObject<ExperimentalImageGenerationDto['previews'][number]>()({ ...preview, binaryObjectId: idToRaw({ id: preview.binaryObjectId }) })),
  });
}

export function imageGenerationSummaryToDomain({ dto }: { dto: ExperimentalImageGenerationSummaryDto }): ImageGenerationSummary {
  return exactObject<ImageGenerationSummary>()({ ...dto, id: toImageGenerationId({ raw: dto.id }), binaryObjectId: toBinaryObjectId({ raw: dto.binaryObjectId }) });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
