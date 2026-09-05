import type { DownloadVerificationModelArtifactRequest } from '@/features/transformers-js/download-verification/types';
import { sanitizeObservedUrl } from '@/features/transformers-js/download-verification/logic/run-browser-download-verification';

export interface ModelArtifactRequestBarrier {
  observe({ request }: { request: DownloadVerificationModelArtifactRequest }): Promise<Response>;
  waitForQuiescence(): Promise<DownloadVerificationModelArtifactRequest[]>;
  stop({ reason }: { reason: Error }): void;
  dispose(): void;
}

export function createModelArtifactRequestBarrier({
  quiescenceMs,
}: {
  quiescenceMs: number,
}): ModelArtifactRequestBarrier {
  const requests = new Map<string, DownloadVerificationModelArtifactRequest>();
  const rejectors = new Set<ReturnType<typeof Promise.withResolvers<Response>>['reject']>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let quiescence = Promise.withResolvers<DownloadVerificationModelArtifactRequest[]>();
  let quiescenceResolved = false;

  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (quiescenceResolved) return;
      quiescenceResolved = true;
      quiescence.resolve([...requests.values()].sort((left, right) => {
        const pathOrder = left.path.localeCompare(right.path);
        return pathOrder !== 0 ? pathOrder : left.url.localeCompare(right.url);
      }));
    }, quiescenceMs);
  };

  return {
    observe({ request }): Promise<Response> {
      requests.set(`${request.path}\u0000${request.url}`, request);
      schedule();
      const pending = Promise.withResolvers<Response>();
      rejectors.add(pending.reject);
      return pending.promise;
    },
    waitForQuiescence(): Promise<DownloadVerificationModelArtifactRequest[]> {
      if (requests.size > 0 && !quiescenceResolved) schedule();
      return quiescence.promise;
    },
    stop({ reason }): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const reject of rejectors) reject(reason);
      rejectors.clear();
    },
    dispose(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      rejectors.clear();
      if (!quiescenceResolved) {
        quiescence = Promise.withResolvers<DownloadVerificationModelArtifactRequest[]>();
      }
    },
  };
}

export function huggingFaceResolveArtifactRequest({ url }: { url: string }): DownloadVerificationModelArtifactRequest | undefined {
  const path = huggingFaceResolveArtifactPath({ url });
  if (path === undefined) return undefined;
  const sanitizedUrl = sanitizeObservedUrl({ value: url });
  if (sanitizedUrl === undefined) return undefined;
  return { path, url: sanitizedUrl };
}

export function huggingFaceResolveArtifactPath({ url }: { url: string }): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.hostname !== 'huggingface.co' && !parsed.hostname.endsWith('.huggingface.co')) return undefined;

  const parts = parsed.pathname.split('/').filter(Boolean);
  const resolveIndex = parts.indexOf('resolve');
  if (resolveIndex < 0 || resolveIndex + 2 >= parts.length) return undefined;
  const artifactParts = parts.slice(resolveIndex + 2);
  try {
    return artifactParts.map(part => decodeURIComponent(part)).join('/');
  } catch {
    return artifactParts.join('/');
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
