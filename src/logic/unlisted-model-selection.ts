import type { Endpoint } from '@/01-models/types';

/** Refreshing an inventory is not reference invalidation. Chat selection and
 * both settings panes must preserve the same resolvable/sometimes-missing names.
 * In particular temp/ references intentionally survive the page that held files;
 * re-registering that name may resolve them to different files without migration. */
export function preservesUnlistedModel({ endpoint, modelId }: { endpoint: Endpoint, modelId: string }): boolean {
  return (endpoint.type === 'llama_cpp_browser' && /^(?:hf\.co|host|temp)\//.test(modelId))
    || (endpoint.type === 'naidan_rpc' && /^(?:host|temp)\//.test(modelId));
}

export const TEST_ONLY = {
};
