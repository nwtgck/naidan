import type { DownloadSizeRequest, DownloadSizeResult } from './types';
export function createDownloadSizeClient() {
  return {
    async collect({ request: _request }: { request: DownloadSizeRequest }): Promise<DownloadSizeResult> {
      return { sizes: [], quotaLimited: false };
    },
    dispose(): void {},
  };
}
export const TEST_ONLY = {
};
