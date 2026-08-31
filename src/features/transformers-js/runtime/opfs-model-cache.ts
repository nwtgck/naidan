import type { TransformersJsCacheRevisionAlias } from '@/features/transformers-js/types';
import { urlToPath, writeToOpfs } from '@/features/transformers-js/utils';

export interface OpfsModelCacheMatchObservation {
  requestedPath: string,
  result: 'hit' | 'alias-hit' | 'miss',
  bytes: number | undefined,
}

function sanitizedCacheRequestPath({ urlString }: { urlString: string }): string {
  try {
    const url = new URL(urlString);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return urlString.split(/[?#]/u, 1)[0] ?? urlString;
  }
}

function revisionAliasUrl({
  urlString,
  revisionAliases,
}: {
  urlString: string,
  revisionAliases: readonly TransformersJsCacheRevisionAlias[],
}): string | undefined {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return undefined;
  }
  if (url.hostname !== 'huggingface.co') return undefined;

  const encodedParts = url.pathname.split('/').filter(Boolean);
  if (encodedParts.length < 5 || encodedParts[2] !== 'resolve') return undefined;
  let parts: string[];
  try {
    parts = encodedParts.map(part => decodeURIComponent(part));
  } catch {
    return undefined;
  }
  const modelId = `${parts[0]}/${parts[1]}`;
  const requestedRevision = parts[3];
  const repositoryPath = parts.slice(4).join('/');
  const alias = revisionAliases.find(item => (
    item.modelId === modelId
    && item.resolvedRevision === requestedRevision
    && item.repositoryPaths.includes(repositoryPath)
  ));
  if (alias === undefined) return undefined;

  const modelPath = alias.modelId.split('/').map(part => encodeURIComponent(part)).join('/');
  const filePath = repositoryPath.split('/').map(part => encodeURIComponent(part)).join('/');
  url.pathname = `/${modelPath}/resolve/${encodeURIComponent(alias.sourceRevision)}/${filePath}`;
  return url.toString();
}

async function matchOpfsPath({
  urlString,
  allowMutation,
}: {
  urlString: string,
  allowMutation: boolean,
}): Promise<Response | undefined> {
  const path = urlToPath({ url: urlString });
  if (!path) return undefined;

  const pathParts = path.split('/');
  const fileName = pathParts.pop()!;

  try {
    const root = await navigator.storage.getDirectory();
    let currentDir = root;
    for (const part of pathParts) {
      if (!part) continue;
      currentDir = await currentDir.getDirectoryHandle(part, { create: false });
    }

    const markerName = `.${fileName}.complete`;
    await currentDir.getFileHandle(markerName, { create: false });

    const fileHandle = await currentDir.getFileHandle(fileName);
    const file = await fileHandle.getFile();

    if (file.size === 0) {
      if (allowMutation) {
        await currentDir.removeEntry(fileName);
        await currentDir.removeEntry(markerName);
      }
      return undefined;
    }

    console.log(`[opfsCache] CACHE HIT: ${path} (${file.size} bytes)`);
    return new Response(file.stream(), {
      headers: {
        'Content-Type': urlString.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        'Content-Length': file.size.toString(),
        'X-Cache-Hit': 'OPFS',
      },
    });
  } catch {
    console.log(`[opfsCache] CACHE MISS: ${path}`);
    return undefined;
  }
}

/**
 * Creates the OPFS cache contract used by Transformers.js.
 *
 * `read-only` is the model-loading contract: cache reads are allowed, but a
 * load MUST NOT create, repair, delete, or overwrite shared model artifacts.
 * `read-write` is reserved for explicit model-download operations.
 */
export function createOpfsModelCache({
  revisionAliases = [],
  mutationPolicy = 'read-write',
  onMatchObservation,
}: {
  revisionAliases?: readonly TransformersJsCacheRevisionAlias[],
  mutationPolicy?: 'read-write' | 'read-only',
  onMatchObservation?: ({ observation }: { observation: OpfsModelCacheMatchObservation }) => void,
} = {}) {
  const reportMatchObservation = onMatchObservation === undefined
    ? undefined
    : ({
      urlString,
      result,
      bytes,
    }: {
        urlString: string,
        result: OpfsModelCacheMatchObservation['result'],
        bytes: number | undefined,
      }): void => {
      onMatchObservation({
        observation: {
          requestedPath: sanitizedCacheRequestPath({ urlString }),
          result,
          bytes,
        },
      });
    };

  const allowMutation = (() => {
    switch (mutationPolicy) {
    case 'read-write': return true;
    case 'read-only': return false;
    default: {
      const _ex: never = mutationPolicy;
      throw new Error(`Unhandled OPFS model cache mutation policy: ${_ex}`);
    }
    }
  })();

  return {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Transformers.js invokes the Cache-compatible API positionally.
    async match(request: string | Request): Promise<Response | undefined> {
      const urlString = typeof request === 'string' ? request : request.url;
      if (typeof request !== 'string' && request.method && request.method !== 'GET') return undefined;

      const exact = await matchOpfsPath({ urlString, allowMutation });
      if (exact !== undefined) {
        reportMatchObservation?.({
          urlString,
          result: 'hit',
          bytes: Number(exact.headers.get('Content-Length')) || undefined,
        });
        return exact;
      }

      const aliasUrl = revisionAliasUrl({ urlString, revisionAliases });
      if (aliasUrl === undefined) {
        reportMatchObservation?.({ urlString, result: 'miss', bytes: undefined });
        return undefined;
      }
      const aliased = await matchOpfsPath({ urlString: aliasUrl, allowMutation });
      if (aliased === undefined) {
        reportMatchObservation?.({ urlString, result: 'miss', bytes: undefined });
        return undefined;
      }
      reportMatchObservation?.({
        urlString,
        result: 'alias-hit',
        bytes: Number(aliased.headers.get('Content-Length')) || undefined,
      });
      const headers = new Headers(aliased.headers);
      headers.set('X-Cache-Revision-Alias', new URL(aliasUrl).pathname);
      return new Response(aliased.body, { status: aliased.status, statusText: aliased.statusText, headers });
    },

    // eslint-disable-next-line local-rules-named-args/require-named-args -- Transformers.js invokes the Cache-compatible API positionally.
    async put(request: string | Request, response: Response): Promise<void> {
      const urlString = typeof request === 'string' ? request : request.url;
      if (!allowMutation) {
        throw new Error(
          `Read-only OPFS model cache MUST NOT be written during model loading: ${urlString}`,
        );
      }
      const path = urlToPath({ url: urlString });
      if (!path) return;

      if (response.status !== 200) {
        console.warn(`[opfsCache] SKIPPING CACHE (status ${response.status}): ${urlString}`);
        return;
      }

      const contentType = response.headers.get('Content-Type') || '';
      if (contentType.includes('text/html')) {
        const msg = `[opfsCache] ERROR: Detected HTML response for model request! Possible 404 fallback from server. URL: ${urlString}`;
        console.error(msg);
        throw new Error(msg);
      }

      try {
        console.log(`[opfsCache] WRITING: ${path}...`);
        await writeToOpfs({ path, response });
        console.log(`[opfsCache] COMPLETED: ${path}`);
      } catch (err) {
        console.error(`[opfsCache] FAILED TO SAVE: ${path}:`, err);
        throw err;
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  revisionAliasUrl,
};
