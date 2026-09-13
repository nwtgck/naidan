import type { ProgressInfo, TransformersJsProgressCallback } from '@/features/transformers-js/types';

/** A slow observer never applies backpressure to the resource writer. */
export function createDownloadProgressEmitter({ callback }: { callback: TransformersJsProgressCallback }) {
  const pending = new Map<string, ProgressInfo>();
  let busy = false;
  let closed = false;
  let lastSent = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const intervalMs = 150;

  function flush(): void {
    if (closed || busy || pending.size === 0) return;
    const entry = [...pending.entries()].find(([, info]) => info.status !== 'progress' && info.status !== 'progress_total') ?? pending.entries().next().value;
    if (entry === undefined) return;
    const [key, info] = entry;
    const terminalOrStage = info.status !== 'progress' && info.status !== 'progress_total';
    const delay = intervalMs - (Date.now() - lastSent);
    if (!terminalOrStage && delay > 0) {
      timer ??= setTimeout(() => {
        timer = undefined; flush();
      }, delay);
      return;
    }
    pending.delete(key);
    lastSent = Date.now();
    busy = true;
    // Keep one callback request in flight. Own synchronous throws and remote
    // rejection alike, without awaiting either from a stream transform.
    void Promise.resolve().then(() => closed ? undefined : callback({ info })).catch(() => undefined).finally(() => {
      busy = false;
      flush();
    });
  }

  return {
    publish({ info }: { info: ProgressInfo }): void {
      if (closed) return;
      // Scalar snapshots only: never retain response bodies or stream chunks.
      const { status, progress, loaded, total, name, file, downloadTiming, downloadTotalKind, ...unhandled } = info;
      unhandled satisfies Record<PropertyKey, never>;
      pending.set(file ?? name ?? '<stage>', { status, ...progress === undefined ? {} : { progress }, ...loaded === undefined ? {} : { loaded }, ...total === undefined ? {} : { total }, ...name === undefined ? {} : { name }, ...file === undefined ? {} : { file }, ...downloadTiming === undefined ? {} : { downloadTiming: typeof downloadTiming === 'object' ? { ...downloadTiming } : downloadTiming }, ...downloadTotalKind === undefined ? {} : { downloadTotalKind } });
      flush();
    },
    close(): void {
      closed = true;
      pending.clear();
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      // The prefetch RPC result carries authoritative per-file terminal states.
      // Closing never waits for an observer which may never acknowledge.
    },
  };
}

export const TEST_ONLY = {
};
