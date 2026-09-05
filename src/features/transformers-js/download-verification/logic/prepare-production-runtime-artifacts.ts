import { createDownloadVerificationRuntimeArtifactPreparationWorkerClient } from '@/features/transformers-js/download-verification/runtime-artifact-preparation-worker/client-hosted';
import { awaitWithAbort } from '@/features/transformers-js/download-verification/logic/await-with-abort';
import { sanitizeDiagnosticText } from '@/features/transformers-js/download-verification/logic/run-browser-download-verification';
import type { DownloadVerificationRuntimeArtifactPreparationObservation } from '@/features/transformers-js/download-verification/types';
import type { TransformersJsProgressCallback } from '@/features/transformers-js/types';

function serializedError({ error }: { error: unknown }): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeDiagnosticText({ value: error.message }),
    };
  }
  return {
    name: 'Error',
    message: sanitizeDiagnosticText({ value: String(error) }),
  };
}

export async function prepareProductionRuntimeArtifacts({ modelId, revision, progressCallback = () => undefined, signal }: {
  modelId: string;
  revision: string;
  progressCallback?: TransformersJsProgressCallback;
  signal?: AbortSignal;
}): Promise<DownloadVerificationRuntimeArtifactPreparationObservation> {
  signal?.throwIfAborted();
  const client = createDownloadVerificationRuntimeArtifactPreparationWorkerClient();
  try {
    const operation = client.prepareModelRuntimeArtifacts({
      modelId,
      revision,
      progressCallback,
    });
    const result = await awaitWithAbort({ operation, signal });
    return {
      modelId,
      revision,
      status: 'prepared',
      processor: result.processor,
      modelType: result.modelType,
      observationMethod: 'transformers-runtime-artifact-preparation',
      error: undefined,
    };
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return {
      modelId,
      revision,
      status: 'failed',
      processor: undefined,
      modelType: undefined,
      observationMethod: 'transformers-runtime-artifact-preparation',
      error: serializedError({ error }),
    };
  } finally {
    try {
      await client.dispose();
    } catch {
      // The dedicated client terminates its Worker in dispose(). A failed remote release
      // must not replace the actual observation/preparation/acceptance outcome.
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
