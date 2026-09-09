import { MISSING_DOWNLOADED_MODEL_ARTIFACT_ERROR_NAME } from './plan-downloaded-model-candidates';
import { REQUIRED_DOWNLOADED_MODEL_RESOURCE_ERROR_NAME, REQUIRED_DOWNLOADED_RESOURCE_CLEANUP_ERROR_NAME } from './required-downloaded-resource-operation';
import { TRANSFORMERS_JS_OPTIONAL_CONFIGURATION_ERROR_NAME } from './transformers-js-optional-configuration-error';

export const DOWNLOADED_MODEL_PREPARATION_ERROR_NAME = 'DownloadedModelPreparationError';
export type DownloadedModelPreparationPhase = 'config' | 'candidate-plan' | 'tokenizer-processor';

/** These shared preparation phases cannot be repaired by choosing another dtype. */
export class DownloadedModelPreparationError extends Error {
  override readonly name = DOWNLOADED_MODEL_PREPARATION_ERROR_NAME;
  readonly phase: DownloadedModelPreparationPhase;

  constructor({ phase, cause }: { phase: DownloadedModelPreparationPhase, cause: unknown }) {
    // Comlink retains Error.name/message, not custom fields. Keep the phase and
    // original message visible without making their wording define authority.
    super(`Downloaded model preparation failed during ${phase}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.phase = phase;
  }
}

export function downloadedModelPreparationError({ phase, cause }: {
  phase: DownloadedModelPreparationPhase, cause: unknown,
}): Error {
  if (cause instanceof Error) {
    switch (cause.name) {
    case MISSING_DOWNLOADED_MODEL_ARTIFACT_ERROR_NAME:
    case 'DownloadedModelResourcePlanningError':
    case REQUIRED_DOWNLOADED_MODEL_RESOURCE_ERROR_NAME:
    case REQUIRED_DOWNLOADED_RESOURCE_CLEANUP_ERROR_NAME:
    case 'ProductionWorkerLifecycleError':
    case DOWNLOADED_MODEL_PREPARATION_ERROR_NAME:
    case TRANSFORMERS_JS_OPTIONAL_CONFIGURATION_ERROR_NAME:
      return cause;
    default:
      break;
    }
  }
  return new DownloadedModelPreparationError({ phase, cause });
}

export async function withDownloadedModelPreparationPhase<T>({ phase, run }: {
  phase: DownloadedModelPreparationPhase, run: () => Promise<T>,
}): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw downloadedModelPreparationError({ phase, cause });
  }
}

export const TEST_ONLY = {
};
