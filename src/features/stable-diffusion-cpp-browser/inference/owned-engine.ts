import type { ImageClient } from '@/features/stable-diffusion-cpp-browser/worker/types';

export class ImageEngineBusyError extends Error {
  constructor() {
    super('The local image engine is busy');
    this.name = 'ImageEngineBusyError';
  }
}

type Owner = { stop: AbortController, onReleased: (() => void) | undefined };

/** One native engine, independent client owners. A late cleanup from one view
 * must never cancel, inspect or release a different owner's generation. */
export function createOwnedImageEngine({ createClient }: {
  createClient: ({ onReleased }: { onReleased: () => void }) => ImageClient,
}) {
  const owners = new Set<Owner>();
  let client: ImageClient | undefined;
  let active: { owner: Owner } | undefined;
  let resident: Owner | undefined;
  let reservation: { owner: Owner, token: object, close(): void } | undefined;
  let nativeGeneration = 0;
  let cacheGeneration = 0;

  function notify({ owner }: { owner: Owner | undefined }): void {
    try {
      owner?.onReleased?.();
    } catch { /* Observers cannot own native lifetime. */ }
  }
  function released(): void {
    cacheGeneration++;
    const previous = resident;
    resident = undefined;
    notify({ owner: previous });
    if (active?.owner !== previous) notify({ owner: active?.owner });
  }
  function collect(): void {
    if (owners.size || active || reservation) return;
    const retired = client;
    nativeGeneration++;
    client = undefined;
    resident = undefined;
    retired?.dispose();
  }
  function createOwner({ onReleased }: { onReleased: (() => void) | undefined }): ImageClient {
    const owner: Owner = { stop: new AbortController(), onReleased };
    owners.add(owner);
    return {
      reserve({ signal }) {
        signal.throwIfAborted(); owner.stop.signal.throwIfAborted();
        if (reservation || active) throw new ImageEngineBusyError();
        const token = {};
        let closing = false;
        function finish(): void {
          if (reservation?.token !== token || !closing || active?.owner === owner) return;
          signal.removeEventListener('abort', close); owner.stop.signal.removeEventListener('abort', close);
          reservation = undefined; collect();
        }
        function close(): void {
          closing = true; finish();
        }
        reservation = { owner, token, close: finish };
        signal.addEventListener('abort', close, { once: true }); owner.stop.signal.addEventListener('abort', close, { once: true });
        return { release: close };
      },
      async generate({ request, signal, onProgress, onPreview, onDiagnostic }) {
        owner.stop.signal.throwIfAborted();
        signal.throwIfAborted();
        if (active || reservation && reservation.owner !== owner) throw new ImageEngineBusyError();
        const operation = { owner };
        active = operation;
        cacheGeneration++;
        if (resident !== owner) {
          const previous = resident;
          resident = undefined;
          notify({ owner: previous });
        }
        try {
          if (!client) {
            const generation = ++nativeGeneration;
            client = createClient({
              onReleased: () => {
              // A disposed native client may deliver a late event. It cannot
              // clear a replacement client's residency or notify its owner.
                if (generation === nativeGeneration && client) released();
              },
            });
          }
          const result = await client.generate({
            request,
            signal: AbortSignal.any([signal, owner.stop.signal]),
            onProgress,
            onPreview,
            onDiagnostic,
          });
          if (!owner.stop.signal.aborted && (!('cancelled' in result) || result.modelResident)) resident = owner;
          return result;
        } finally {
          // Even an implementation that ignores cancellation retains its slot
          // until the actual generate promise settles, not until abort is sent.
          if (active === operation) {
            active = undefined;
            if (owner.stop.signal.aborted) {
              client?.release({ reason: 'page-exit' });
              if (resident === owner) resident = undefined;
            }
          }
          reservation?.close();
          collect();
        }
      },
      cancel() {
        if (!owner.stop.signal.aborted && active?.owner === owner) client?.cancel();
      },
      updatePreview({ settings }) {
        if (!owner.stop.signal.aborted && active?.owner === owner) client?.updatePreview({ settings });
      },
      async inspectEngine() {
        if (owner.stop.signal.aborted) return { status: 'unavailable', reason: 'released' };
        if (active) return { status: 'unavailable', reason: 'busy' };
        if (resident !== owner || !client) return { status: 'unavailable', reason: 'not-loaded' };
        const source = client, generation = cacheGeneration;
        const result = await source.inspectEngine();
        if (owner.stop.signal.aborted || client !== source) return { status: 'unavailable', reason: 'released' };
        if (active) return { status: 'unavailable', reason: 'busy' };
        if (resident !== owner || generation !== cacheGeneration) return { status: 'unavailable', reason: 'not-loaded' };
        return result;
      },
      release({ reason } = {}) {
        if (owner.stop.signal.aborted || active && active.owner !== owner || reservation && reservation.owner !== owner) return;
        if (active?.owner !== owner && resident !== owner) return;
        client?.release({ reason });
        if (resident === owner) resident = undefined;
        notify({ owner });
      },
      dispose() {
        if (owner.stop.signal.aborted) return;
        owner.stop.abort();
        owners.delete(owner);
        if (resident === owner && !active) {
          client?.release({ reason: 'page-exit' });
          resident = undefined;
        }
        notify({ owner });
        collect();
      },
    };
  }
  return { createOwner };
}

export const TEST_ONLY = {
};
