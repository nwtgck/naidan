import { acquireSharedHighlightWorkerClientLease, type SharedHighlightWorkerClientLease } from '@/features/highlight/worker/client-shared';
import { sanitizeHighlightHtml, type AllowedHtml } from '@/logic/security/allowedHtml';
import { EXTENSION_LANGUAGE_MAP } from '@/features/file-explorer/logic/constants';

export function createFileExplorerCodeHighlighter() {
  let leasePromise: Promise<SharedHighlightWorkerClientLease> | undefined;
  let disposed = false;

  async function highlight({ extension, text }: { extension: string, text: string }): Promise<AllowedHtml | undefined> {
    if (disposed) {
      return undefined;
    }
    const pending = leasePromise ??= acquireSharedHighlightWorkerClientLease();
    const lease = await pending.catch(() => {
      if (leasePromise === pending) {
        leasePromise = undefined;
      }
      return undefined;
    });
    if (disposed || lease === undefined) {
      return undefined;
    }
    try {
      const language = EXTENSION_LANGUAGE_MAP[extension];
      const { html } = await lease.client.highlight({ request: { code: text, language, mode: language ? 'named-language' : 'auto-detect' } });
      return disposed ? undefined : sanitizeHighlightHtml({ html });
    } catch {
      return undefined;
    }
  }

  function dispose(): void {
    disposed = true;
    const pending = leasePromise;
    leasePromise = undefined;
    void pending?.then(lease => lease.release()).catch(error => {
      console.error('Failed to release the file preview highlight worker:', error);
    });
  }

  return { highlight, dispose };
}

export const TEST_ONLY = {
};
