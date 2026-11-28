import { exactObject } from '@/utils/exact-object';
import type {
  ExperimentalImageGenerationAssetDto,
  ExperimentalImageGenerationAssetSummaryDto,
  ExperimentalImageGenerationDto,
  ExperimentalImageGenerationRequestDto,
  ExperimentalImageGenerationRunDto,
  ExperimentalImageGenerationRunSummaryDto,
  ExperimentalImageGenerationSummaryDto,
} from './00-dto/experimental-image-generation.dto';

function indexModelName({ request }: { request: ExperimentalImageGenerationRequestDto }): string {
  const runtime = request.runtime;
  switch (runtime.profile) {
  case 'naidan-rpc': return runtime.modelSelection?.primary.file.location.path ?? runtime.label;
  case 'webgpu-wasm32-asyncify': case 'webgpu-wasm32-jspi': case 'webgpu-wasm64-jspi': return request.models.find(model => model.slot === 'model' || model.slot === 'diffusion')?.file.name ?? '';
  default: {
    const exhaustive: never = runtime;
    throw new Error(String(exhaustive));
  }
  }
}

export function imageGenerationToIndexSummary({ record }: { record: ExperimentalImageGenerationDto }): ExperimentalImageGenerationSummaryDto {
  return {
    id: record.id,
    createdAt: record.createdAt,
    prompt: record.request.parameters.prompt,
    modelName: indexModelName({ request: record.request }),
    binaryObjectId: record.result.binaryObjectId,
    width: record.result.width,
    height: record.result.height,
    previewCount: record.previews.length,
  };
}

export function imageGenerationRunToIndexSummary({ record }: { record: ExperimentalImageGenerationRunDto }): ExperimentalImageGenerationRunSummaryDto {
  const { id, sessionId, operationId, revision, createdAt, execution, request, seeds, sources: _sources, acceptedOrder: _acceptedOrder, ...unhandled } = record;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<ExperimentalImageGenerationRunSummaryDto>()({
    ...(operationId === undefined ? {} : { operationId }),
    id,
    sessionId,
    revision,
    createdAt,
    execution,
    prompt: request.parameters.prompt,
    modelName: indexModelName({ request }),
    requestedCount: seeds.length,
  });
}

export function imageGenerationAssetToIndexSummary({ record }: { record: ExperimentalImageGenerationAssetDto }): ExperimentalImageGenerationAssetSummaryDto {
  const { result, previews, ...metadata } = record;
  const { binaryObjectId, width, height, confirmation, modelVersion: _modelVersion, uniformOutput: _uniformOutput, elapsedMs: _elapsedMs, sampling: _sampling, resolvedParameters: _resolvedParameters, ...unhandled } = result;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<ExperimentalImageGenerationAssetSummaryDto>()({
    ...metadata,
    ...(() => {
      switch (confirmation) {
      case 'unconfirmed': return { confirmation };
      case 'confirmed': case undefined: return {};
      default: {
        const exhaustive: never = confirmation;
        throw new Error(String(exhaustive));
      }
      }
    })(),
    binaryObjectId,
    width,
    height,
    previewCount: previews.length,
  });
}

export const TEST_ONLY = {
};
