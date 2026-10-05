import type { Endpoint } from '@/01-models/types';

export type ModelLaunchDefaultSnapshot = { endpoint: Endpoint, modelId: string | undefined, revision: number, storedMatches: boolean, isStorageCurrent: () => boolean };
export function canInitializeModelLaunchDefaults({ endpoint, modelId }: { endpoint: Endpoint, modelId: string | undefined }): boolean {
  if (modelId !== undefined && modelId !== '') return false;
  switch (endpoint.type) {
  case 'llama_cpp_browser': return true;
  case 'openai': case 'ollama': return endpoint.url === '' && (endpoint.httpHeaders === undefined || endpoint.httpHeaders.length === 0);
  case 'naidan_rpc': case 'transformers_js': case 'browser_provided_lm': case 'unsupported_experimental_endpoint': return false;
  default: { const exhaustive: never = endpoint; throw new Error(String(exhaustive)); }
  }
}
export const TEST_ONLY = {
};
