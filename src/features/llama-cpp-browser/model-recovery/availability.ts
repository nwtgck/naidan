import { readonly, ref } from 'vue';
import { storedModelDirectory } from '@/features/llama-cpp-browser/runtime/model-store';
import { resolveStoredModelName } from '@/features/llama-cpp-browser/host-model-names';
import { errorCode } from '@/features/llama-cpp-browser/types';

export type ModelAvailability = 'available' | 'missing' | 'unreadable';

/** Local inspection only. No Worker, catalog request, or model payload read.
 * The store checks GGUF headers and split-file completeness for this source;
 * it does not enumerate every repository or load weights into memory. */
export async function inspectLocalModel({ modelId }: { modelId: string }): Promise<ModelAvailability> {
  try {
    await storedModelDirectory({ name: await resolveStoredModelName({ name: modelId }) });
    return 'available';
  } catch (error) {
    if ((error instanceof DOMException && error.name === 'NotFoundError') || errorCode({ error }) === 'missing-model') return 'missing';
    // Permission, corrupt metadata, unsupported/ambiguous layouts and missing
    // browser storage support are not evidence that downloading would help.
    return 'unreadable';
  }
}

/** Cache only tiny observations, not File objects, credentials or model bytes.
 * Invalidation retires in-flight results too. Generation still validates files
 * itself; this short-lived cache is a presentation optimization, not authority. */
export function createModelAvailabilityCache({ inspect, now }: {
  inspect: typeof inspectLocalModel, now: () => number,
}) {
  type Entry = { expires: number, pending: Promise<ModelAvailability> };
  const entries = new Map<string, Entry>();
  const revision = ref(0);
  function invalidate(): void {
    entries.clear(); revision.value++;
  }
  function check({ modelId }: { modelId: string }): Promise<ModelAvailability> {
    const existing = entries.get(modelId);
    if (existing !== undefined && existing.expires > now()) return existing.pending;
    const entry: Entry = { expires: Number.POSITIVE_INFINITY, pending: Promise.resolve('unreadable') };
    entry.pending = Promise.resolve().then(() => inspect({ modelId })).catch((): ModelAvailability => 'unreadable').then(result => {
      if (entries.get(modelId) === entry) {
        switch (result) {
        case 'available': case 'missing': entry.expires = now() + 5000; break;
        case 'unreadable': entry.expires = now(); break;
        default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
        }
      }
      return result;
    });
    entries.delete(modelId); entries.set(modelId, entry);
    if (entries.size > 32) entries.delete(entries.keys().next().value!);
    return entry.pending;
  }
  return { check, invalidate, revision: readonly(revision) };
}

export const localModelAvailability = createModelAvailabilityCache({ inspect: inspectLocalModel, now: () => Date.now() });
export const TEST_ONLY = {
};
