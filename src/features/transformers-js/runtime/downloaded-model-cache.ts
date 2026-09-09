import { normalizeTransformersJsProductionModelId } from '@/features/transformers-js/production-routing';
import { createOpfsModelCache, sanitizedCacheRequestPath, type OpfsModelCacheMatchObservation } from '@/features/transformers-js/runtime/opfs-model-cache';
import { urlToPath } from '@/features/transformers-js/utils';

// Transformers.js 4.2 ModelRegistry probes these files without forwarding the
// caller's revision option. During an immutable-revision cache-only load, those
// probes therefore ask for `main` even though the downloaded artifacts live
// under the resolved commit SHA. Canonicalize only the presence-probe files; the
// actual tokenizer/processor/model files continue to use the requested exact
// revision and remain fail-closed on cache misses.
const REVISION_INSENSITIVE_RUNTIME_METADATA_PATHS = [
  'tokenizer_config.json',
  'preprocessor_config.json',
] as const;

/** Resolve one operation's admissible cache requests before any native I/O. */
export function createDownloadedModelCacheScope({ modelId, revision }: {
  modelId: string,
  revision: string | undefined,
}) {
  const normalizedModelId = normalizeTransformersJsProductionModelId({ modelId });
  const localModelPath = normalizedModelId.startsWith('user/') || normalizedModelId.startsWith('local/')
    ? `models/user/${normalizedModelId.slice(normalizedModelId.indexOf('/') + 1)}/`
    : undefined;
  const encodedModelId = normalizedModelId.split('/').map(part => encodeURIComponent(part)).join('/');
  const selectedPrefix = `/${encodedModelId}/resolve/${encodeURIComponent(revision ?? 'main')}/`;
  const mainPrefix = `/${encodedModelId}/resolve/main/`;
  function scopedRequestUrl({ urlString }: { urlString: string }): string | undefined {
    if (localModelPath !== undefined) {
      const path = urlToPath({ url: urlString });
      return path?.startsWith(localModelPath) && !path.split('/').some(part => part === '.' || part === '..')
        ? urlString
        : undefined;
    }
    let url: URL;
    try {
      url = new URL(urlString);
    } catch {
      // Upstream probes its local namespace first, even for HF model IDs.
      // A local upload must not shadow any part of this HF operation.
      return undefined;
    }
    if (url.origin !== 'https://huggingface.co' || url.username || url.password) return undefined;
    if (url.pathname.startsWith(selectedPrefix)) return urlString;
    if (url.pathname.startsWith(mainPrefix)) {
      const repositoryPath = url.pathname.slice(mainPrefix.length);
      if (REVISION_INSENSITIVE_RUNTIME_METADATA_PATHS.some(path => path === repositoryPath)) {
        // Resolve before lookup, including when mutable main is already cached.
        url.pathname = `${selectedPrefix}${repositoryPath}`;
        return url.href;
      }
    }
    return undefined;
  }

  return {
    resolve({ request }: { request: string | Request }):
      | { kind: 'admitted', url: string, resourceKey: string }
      | { kind: 'outside-scope' }
      | { kind: 'unsupported-method' } {
      if (typeof request !== 'string' && request.method !== 'GET') return { kind: 'unsupported-method' };
      const url = scopedRequestUrl({ urlString: typeof request === 'string' ? request : request.url });
      if (url === undefined) return { kind: 'outside-scope' };
      // Compare only after namespace admission. Existing local URL spellings
      // may share one OPFS file; keep the lookup spelling and escaping intact.
      const resourceKey = urlToPath({ url });
      return resourceKey === null ? { kind: 'outside-scope' } : { kind: 'admitted', url, resourceKey };
    },
  };
}

export function createDownloadedModelReadOnlyCache({ modelId, revision, onMatchObservation }: {
  modelId: string,
  revision: string | undefined,
  onMatchObservation?: ({ observation }: { observation: OpfsModelCacheMatchObservation }) => void,
}): ReturnType<typeof createOpfsModelCache> {
  const scope = createDownloadedModelCacheScope({ modelId, revision });
  const cache = createOpfsModelCache({ mutationPolicy: 'read-only', revisionAliases: [] });
  return {
    ...cache,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Transformers.js invokes the Cache-compatible API positionally.
    async match(request: string | Request): Promise<Response | undefined> {
      const urlString = typeof request === 'string' ? request : request.url;
      const resolution = scope.resolve({ request });
      const scopedUrl = (() => {
        switch (resolution.kind) {
        case 'admitted': return resolution.url;
        case 'outside-scope':
        case 'unsupported-method': return undefined;
        default: {
          const _ex: never = resolution;
          throw new Error(`Unhandled cache scope result ${_ex}`);
        }
        }
      })();
      const response = scopedUrl === undefined ? undefined : await cache.match(scopedUrl);
      const aliased = scopedUrl !== undefined && scopedUrl !== urlString;
      // Each invocation owns its original identity across concurrent matches.
      onMatchObservation?.({ observation: {
        requestedPath: sanitizedCacheRequestPath({ urlString }),
        result: response === undefined ? 'miss' : aliased ? 'alias-hit' : 'hit',
        bytes: response === undefined ? undefined : Number(response.headers.get('Content-Length')) || undefined,
      } });
      if (response !== undefined && aliased) {
        response.headers.set('X-Cache-Revision-Alias', new URL(scopedUrl).pathname);
      }
      return response;
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
