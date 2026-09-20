import type { LlamaCppBrowserService } from './service-contract';
import { LlamaCppBrowserError } from './types';
const unsupported = async (): Promise<never> => {
  throw new LlamaCppBrowserError({ code: 'unavailable' });
};
/** The UI retains this surface, but no storage, worker or native runtime is imported. */
export const llamaCppBrowserService: LlamaCppBrowserService = {
  getState: () => ({ status: 'unavailable' }),
  getOptions: () => ({ profile: 'auto' }),
  setOptions() {},
  subscribe({ listener }) {
    listener({ state: { status: 'unavailable' } }); return () => {};
  },
  subscribeModelList() {
    return () => {};
  },
  listModels: async () => [], importModel: unsupported, removeModel: unsupported, generate: unsupported,
  cancel() {}, release() {},
};
export const TEST_ONLY = {
};
