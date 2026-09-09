// eslint-disable-next-line no-restricted-imports -- Worker-only type boundary; the owning entry supplies the runtime instance.
import type { ProgressCallback } from '@huggingface/transformers';
import type { TransformersJsRuntimeArtifactPreparationResult } from '@/features/transformers-js/types';
import { selectTransformersJsProductionAutoClass, selectTransformersJsProductionRuntimeArtifactLoader } from '@/features/transformers-js/production-routing';
import { TRANSFORMERS_JS_PRODUCTION_LOAD_CANDIDATES } from '@/features/transformers-js/production-load-candidates';
import { selectProductionModelResources } from '@/features/transformers-js/runtime/production-resource-selector';
import { ProductionResourceCandidateError, type ProductionCandidateResourcePlan } from '@/features/transformers-js/runtime/production-resource-plan';
import { createRuntimeMetadataOperation } from './metadata-operation';
import type { RuntimeMetadataStorage } from './metadata-storage';
import type { RuntimeMetadataPreparationStage } from './runtime-metadata-preparation-types';

/**
 * One runtime preparation path for explicit Download and fresh investigation.
 * The caller owns a dedicated runtime/Worker and forbids concurrent operations.
 * Storage selects persistence, not a different tokenizer or resource algorithm.
 * A failed call requires retiring that runtime, even after environment cleanup.
 */
export async function prepareRuntimeMetadata({ modelId, revision, runtime, downloadFetch, storage, maximumByteLength, progressCallback, onStage }: {
  modelId: string,
  revision: string,
  runtime: Pick<typeof import('@huggingface/transformers'), 'AutoConfig' | 'AutoProcessor' | 'AutoTokenizer' | 'env'>,
  downloadFetch: typeof fetch,
  storage: RuntimeMetadataStorage,
  maximumByteLength: number,
  progressCallback: ProgressCallback,
  onStage: ({ stage }: { stage: RuntimeMetadataPreparationStage }) => void,
}): Promise<TransformersJsRuntimeArtifactPreparationResult> {
  const { AutoConfig, AutoProcessor, AutoTokenizer, env } = runtime;
  const previousFetch = env.fetch;
  const previousCache = env.customCache;
  const operation = createRuntimeMetadataOperation({ modelId, revision, downloadFetch, storage, maximumByteLength });
  env.fetch = operation.fetch;
  env.customCache = operation.cache;
  try {
    const sharedOptions = { revision, progress_callback: progressCallback, local_files_only: false };
    onStage({ stage: 'configuration' });
    const config = await AutoConfig.from_pretrained(modelId, sharedOptions);
    const modelType = typeof config.model_type === 'string' ? config.model_type : undefined;
    const resourcePlansByCandidate: Record<string, ProductionCandidateResourcePlan> = {};
    onStage({ stage: 'resource-selection' });
    for (const candidate of TRANSFORMERS_JS_PRODUCTION_LOAD_CANDIDATES) {
      try {
        resourcePlansByCandidate[`${candidate.device}/${candidate.dtype}`] = { status: 'ready', paths: selectProductionModelResources({
          autoClass: selectTransformersJsProductionAutoClass({ modelId }), config, candidate,
        }).paths };
      } catch (error) {
        if (!(error instanceof ProductionResourceCandidateError)) throw error;
        resourcePlansByCandidate[`${candidate.device}/${candidate.dtype}`] = { status: 'planning-failed', error: { name: error.name, message: error.message } };
      }
    }
    const processor = selectTransformersJsProductionRuntimeArtifactLoader({ modelId, modelType });
    switch (processor) {
    case 'gemma4-processor':
    case 'qwen3_5-processor':
      onStage({ stage: 'processor' });
      await AutoProcessor.from_pretrained(modelId, sharedOptions);
      break;
    case 'tokenizer':
      onStage({ stage: 'tokenizer' });
      await AutoTokenizer.from_pretrained(modelId, sharedOptions);
      break;
    default: {
      const _ex: never = processor;
      throw new Error(`Unhandled Production runtime artifact loader: ${_ex}`);
    }
    }
    onStage({ stage: 'storage-finalization' });
    await operation.finish();
    onStage({ stage: 'complete' });
    return { processor, modelType, resourcePlansByCandidate };
  } catch (error) {
    return await operation.abort({ error });
  } finally {
    env.fetch = previousFetch;
    env.customCache = previousCache;
  }
}

export const TEST_ONLY = {
};
