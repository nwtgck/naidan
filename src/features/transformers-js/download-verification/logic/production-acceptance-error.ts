import { MISSING_DOWNLOADED_MODEL_ARTIFACT_ERROR_NAME } from '@/features/transformers-js/runtime/plan-downloaded-model-candidates';
import { DOWNLOADED_MODEL_PREPARATION_ERROR_NAME } from '@/features/transformers-js/runtime/downloaded-model-preparation-error';
import { TRANSFORMERS_JS_OPTIONAL_CONFIGURATION_ERROR_NAME } from '@/features/transformers-js/runtime/transformers-js-optional-configuration-error';
import {
  REQUIRED_DOWNLOADED_MODEL_RESOURCE_ERROR_NAME,
  REQUIRED_DOWNLOADED_RESOURCE_CLEANUP_ERROR_NAME,
} from '@/features/transformers-js/runtime/required-downloaded-resource-operation';
import { sanitizeDiagnosticText } from './run-browser-download-verification';

/** Error.name survives Comlink; instanceof and message fragments do not define authority. */
export function classifyProductionAcceptanceError({ error }: { error: unknown }): 'terminal' | 'incomplete' | 'runtime-rejected' {
  const name = error instanceof Error ? error.name : undefined;
  switch (name) {
  case REQUIRED_DOWNLOADED_MODEL_RESOURCE_ERROR_NAME:
  case REQUIRED_DOWNLOADED_RESOURCE_CLEANUP_ERROR_NAME:
  case DOWNLOADED_MODEL_PREPARATION_ERROR_NAME:
  case TRANSFORMERS_JS_OPTIONAL_CONFIGURATION_ERROR_NAME:
  case 'DownloadedModelResourcePlanningError':
  case 'ProductionWorkerLifecycleError':
    return 'terminal';
  case MISSING_DOWNLOADED_MODEL_ARTIFACT_ERROR_NAME:
    return 'incomplete';
  default:
    return 'runtime-rejected';
  }
}

export function serializeProductionAcceptanceError({ error }: { error: unknown }): { name: string; message: string } {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: sanitizeDiagnosticText({ value: error instanceof Error ? error.message : String(error) }),
  };
}

export function productionAcceptanceFailureStatus({ error }: { error: unknown }): 'failed' | 'rejected' {
  const classification = classifyProductionAcceptanceError({ error });
  switch (classification) {
  case 'terminal':
  case 'incomplete':
    return 'failed';
  case 'runtime-rejected':
    return 'rejected';
  default: {
    const _ex: never = classification;
    throw new Error(`Unhandled Production acceptance error: ${_ex}`);
  }
  }
}

export const TEST_ONLY = {
};
