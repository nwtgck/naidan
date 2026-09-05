import { normalizeTransformersJsProductionModelId } from '@/features/transformers-js/production-routing';

export interface ResolvedPublicHuggingFaceRevision {
  normalizedModelId: string;
  requestedRevision: 'main';
  resolvedRevision: string;
}

function encodedModelId({ modelId }: { modelId: string }): string {
  const normalized = normalizeTransformersJsProductionModelId({ modelId }).trim().replace(/^\/+|\/+$/g, '');
  const parts = normalized.split('/');
  if (parts.length !== 2 || parts.some(part => part.length === 0 || part === '.' || part === '..')) {
    throw new Error(`Unsupported Hugging Face model ID: ${modelId}`);
  }
  return parts.map(part => encodeURIComponent(part)).join('/');
}

export async function resolvePublicHuggingFaceRevision({ modelId, repositoryFetch = fetch, signal }: {
  modelId: string;
  repositoryFetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ResolvedPublicHuggingFaceRevision> {
  signal?.throwIfAborted();
  const normalizedModelId = normalizeTransformersJsProductionModelId({ modelId }).trim().replace(/^\/+|\/+$/g, '');
  if (normalizedModelId.startsWith('user/')) {
    throw new Error('Public Hugging Face revision resolution does not support local user models');
  }

  const url = `https://huggingface.co/api/models/${encodedModelId({ modelId })}/revision/main`;
  const response = await repositoryFetch(url, {
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal,
  });
  if (!response.ok) {
    throw new Error(`Hugging Face repository metadata request failed: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type')?.toLowerCase();
  if (contentType?.includes('text/html') === true) {
    throw new Error('Hugging Face repository metadata returned HTML instead of JSON');
  }

  let metadata: unknown;
  try {
    metadata = await response.json();
  } catch (error) {
    throw new Error('Hugging Face repository metadata is not valid JSON', { cause: error });
  }
  const resolvedRevision = typeof metadata === 'object' && metadata !== null && 'sha' in metadata
    ? (metadata as { sha?: unknown }).sha
    : undefined;
  if (typeof resolvedRevision !== 'string' || !/^[0-9a-f]{40}$/iu.test(resolvedRevision)) {
    throw new Error('Hugging Face repository metadata did not include a resolved commit SHA');
  }

  return {
    normalizedModelId,
    requestedRevision: 'main',
    resolvedRevision,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  encodedModelId,
};
