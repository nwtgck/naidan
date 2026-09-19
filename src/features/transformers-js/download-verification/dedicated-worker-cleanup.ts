import { releaseWorkerRemote, type WorkerRemote } from '@/utils/worker-transport';

/** Own pending RPCs and physical cleanup even when the Worker never exposes RPC. */
export function createDedicatedDownloadWorkerSession<Api>({ worker, createRemote }: {
  worker: Worker;
  createRemote: () => WorkerRemote<Api>;
}) {
  const stopped = Promise.withResolvers<never>();
  void stopped.promise.catch(() => undefined);
  let terminalError: Error | undefined;
  let disposed = false;
  let remote: WorkerRemote<Api> | undefined;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    terminalError ??= new Error('Download Worker disposed');
    stopped.reject(terminalError);
    worker.removeEventListener('error', onError);
    worker.removeEventListener('messageerror', onMessageError);
    if (remote === undefined) worker.terminate();
    else disposeDedicatedWorkerBestEffort({ remote, worker });
  };
  const fail = ({ error }: { error: Error }) => {
    if (disposed) return;
    terminalError = error;
    stopped.reject(error);
    dispose();
  };
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native EventListener receives one positional Event.
  const onError = (event: Event) => {
    const error = typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent
      ? event.error instanceof Error ? event.error : new Error(event.message || 'Download Worker failed')
      : new Error('Download Worker failed');
    fail({ error });
  };
  const onMessageError = () => fail({ error: new Error('Download Worker response could not be decoded') });

  try {
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    remote = createRemote();
  } catch (error) {
    dispose();
    throw error;
  }
  const activeRemote = remote;
  return {
    isActive: () => !disposed,
    async run<T>({ operation }: { operation: ({ remote }: { remote: WorkerRemote<Api> }) => Promise<T> }): Promise<T> {
      if (terminalError !== undefined) throw terminalError;
      const result = operation({ remote: activeRemote });
      // Race even if a synchronous Worker event stopped the session during
      // invocation: the remote promise still needs a rejection observer.
      return await Promise.race([result, stopped.promise]);
    },
    dispose,
  };
}

export function disposeDedicatedWorkerBestEffort<Api>({
  remote,
  worker,
}: {
  remote: WorkerRemote<Api>;
  worker: Worker;
}): void {
  try {
    const release = releaseWorkerRemote({ remote });
    void Promise.resolve(release).catch(() => undefined);
  } catch {
    // The Worker is terminated below. Remote release is advisory cleanup and must not
    // delay or replace a completed Download Verification result.
  }
  worker.terminate();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
