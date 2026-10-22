import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import type { ErrorCode, LocalModel } from '@/features/llama-cpp-browser/types';
import type { HostModelInventoryIssue } from '@/features/llama-cpp-browser/runtime/host-model-store';

/** A containing surface may own a live, read-only inventory for several views. */
export type ModelInventorySource = {
  models: LocalModel[],
  hostIssues: readonly HostModelInventoryIssue[],
  error: ErrorCode | undefined,
  refreshing: boolean,
  refresh(): Promise<void>,
};

type Listing = { controller: AbortController, promise: Promise<LocalModel[]>, consumers: Set<object> };
let listing: Listing | undefined;
let retiredScan: Promise<void> = Promise.resolve();

/** Concurrent visible libraries share one scan; each owns its own cancellation. */
export function listModelInventory({ signal }: { signal: AbortSignal }): Promise<LocalModel[]> {
  signal.throwIfAborted();
  let shared = listing;
  if (!shared) {
    const controller = new AbortController();
    shared = {
      controller,
      consumers: new Set(),
      promise: retiredScan.then(() => {
        controller.signal.throwIfAborted();
        return llamaCppBrowserModelFiles.listModelEntries({ signal: controller.signal });
      }),
    };
    listing = shared;
    const current = shared;
    void shared.promise.finally(() => {
      if (listing === current) {
        listing = undefined;
      }
    }).catch(() => {});
  }
  const current = shared;
  const consumer = {};
  current.consumers.add(consumer);
  return new Promise((resolve, reject) => {
    function release(): void {
      signal.removeEventListener('abort', abort);
      current.consumers.delete(consumer);
      if (!current.consumers.size && listing === current) {
        listing = undefined;
        current.controller.abort();
        // An aborted filesystem API may settle late. A replacement scan waits
        // for it so quick hide/show cannot overlap expensive inventory reads.
        retiredScan = current.promise.then(() => {}, () => {});
      }
    }
    function abort(): void {
      release();
      reject(signal.reason);
    }
    signal.addEventListener('abort', abort, { once: true });
    void current.promise.then(models => {
      if (!signal.aborted) {
        release();
        resolve(models);
      }
    }, error => {
      if (!signal.aborted) {
        release();
        reject(error);
      }
    });
  });
}

export const TEST_ONLY = {
};
