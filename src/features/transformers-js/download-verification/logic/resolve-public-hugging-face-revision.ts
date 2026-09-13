import { normalizeTransformersJsProductionModelId } from '@/features/transformers-js/production-routing';
import { z } from 'zod';

export interface ResolvedPublicHuggingFaceRevision {
  normalizedModelId: string;
  requestedRevision: 'main';
  resolvedRevision: string;
  sizeHints?: readonly { path: string; bytes: number }[];
}

const siblingSizeSchema = z.object({ rfilename: z.string().min(1), size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), lfs: z.object({ size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).optional() });

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

  // Reuse only optional scalars already present in this exact-SHA response.
  // Do not enlarge the mandatory API request or fail SHA resolution for size.
  const sizeHints = new Map<string, number>();
  const invalid = new Set<string>();
  const seen = new Set<string>();
  if (typeof metadata === 'object' && metadata !== null && 'siblings' in metadata && Array.isArray(metadata.siblings)) {
    for (const sibling of metadata.siblings.slice(0, 256)) {
      const identity = z.object({ rfilename: z.string() }).safeParse(sibling);
      if (!identity.success) continue;
      const path = identity.data.rfilename;
      if (seen.has(path)) invalid.add(path);
      seen.add(path);
      const item = siblingSizeSchema.safeParse(sibling);
      if (!item.success) {
        invalid.add(path); continue;
      }
      const { rfilename: _path, size, lfs } = item.data;
      const bytes = size ?? lfs?.size;
      if (sizeHints.has(path) || size !== undefined && lfs !== undefined && size !== lfs.size) invalid.add(path);
      if (bytes !== undefined) sizeHints.set(path, bytes);
    }
  }
  const hints = [...sizeHints].filter(([path]) => !invalid.has(path)).map(([path, bytes]) => ({ path, bytes }));

  return {
    normalizedModelId,
    requestedRevision: 'main',
    resolvedRevision,
    ...hints.length === 0 ? {} : { sizeHints: hints },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  encodedModelId,
};
