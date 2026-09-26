import type { Request } from './types';

/** No file reads, network, prompt hashing or size-based identity guesses. */
export function createImageSessionKeys() {
  const files = new WeakMap<File, number>();
  let next = 0;
  function token({ file }: { file: File }): number {
    let value = files.get(file);
    if (value === undefined) {
      value = ++next; files.set(file, value);
    }
    return value;
  }
  function key({ request }: { request: Request }): string {
    const { flashAttention, conditioningCacheSize, modelArguments } = request.parameters;
    return JSON.stringify({
      artifact: request.artifact, baseUrl: request.baseUrl, debug: request.debug ?? 'off',
      weightResidency: request.weightResidency, gpuBudgetMiB: request.gpuBudgetMiB,
      flashAttention, conditioningCacheSize, modelArguments,
      models: request.models.map(model => ({ slot: model.slot, path: model.path ?? model.file.name,
        // Library identity covers the publication and all companions. Manual
        // File objects with identical names/size/time are still distinct.
        source: model.sourceId ?? [token({ file: model.file }), ...(model.companions ?? []).map(entry => [entry.path, token({ file: entry.file })])],
      })).sort((a, b) => a.slot.localeCompare(b.slot)),
    });
  }
  return { key };
}
export const TEST_ONLY = {
};
