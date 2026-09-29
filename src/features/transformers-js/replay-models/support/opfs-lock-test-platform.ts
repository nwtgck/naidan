/** Deterministic cooperative platform mechanics, not native tab/Worker locks. */
export function createLockQueue() {
  type Request = {
    name: string;
    mode: LockMode;
    callback: LockGrantedCallback<unknown>;
    resolve: ReturnType<typeof Promise.withResolvers<unknown>>['resolve'];
    reject: ReturnType<typeof Promise.withResolvers<unknown>>['reject'];
    signal: AbortSignal | undefined;
    cancel: (() => void) | undefined;
  };
  const held = new Map<string, Request[]>();
  const queued: Request[] = [];
  const events: string[] = [];

  function drain(): void {
    for (const item of [...queued]) {
      const index = queued.indexOf(item);
      if (index < 0 || queued.slice(0, index).some(prior => prior.name === item.name)) continue;
      const owners = held.get(item.name) ?? [];
      if (owners.some(owner => owner.mode === 'exclusive' || item.mode === 'exclusive')) continue;
      queued.splice(index, 1);
      if (item.cancel !== undefined) item.signal?.removeEventListener('abort', item.cancel);
      owners.push(item);
      held.set(item.name, owners);
      events.push(`grant:${item.name}:${item.mode}`);
      const release = () => {
        owners.splice(owners.indexOf(item), 1);
        if (owners.length === 0) held.delete(item.name);
        events.push(`release:${item.name}:${item.mode}`);
        drain();
      };
      const lock: Lock = { name: item.name, mode: item.mode };
      // Hold the lease through callback settlement, and release it before
      // resolving request(). Abort only removes requests that are still queued.
      void Promise.resolve().then(() => item.callback(lock)).then(value => {
        release(); item.resolve(value);
      }, error => {
        release(); item.reject(error);
      });
    }
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the native LockManager.request boundary used by Production.
  const request = (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>): Promise<unknown> => new Promise((resolve, reject) => {
    if (options.steal) throw new Error('This platform does not emulate lock stealing');
    const signal = options.signal;
    signal?.throwIfAborted();
    const mode = options.mode ?? 'exclusive';
    if (options.ifAvailable && (queued.some(item => item.name === name) || (held.get(name) ?? []).some(item => mode === 'exclusive' || item.mode === 'exclusive'))) {
      void Promise.resolve().then(() => callback(null)).then(resolve, reject);
      return;
    }
    const item: Request = { name, mode, callback, resolve, reject, signal, cancel: undefined };
    if (signal !== undefined) {
      item.cancel = () => {
        const index = queued.indexOf(item);
        if (index < 0) return;
        queued.splice(index, 1);
        if (item.cancel !== undefined) signal.removeEventListener('abort', item.cancel);
        events.push(`abort:${name}:${mode}`);
        reject(signal.reason);
        drain();
      };
      signal.addEventListener('abort', item.cancel, { once: true });
    }
    queued.push(item);
    drain();
  });
  return { locks: { request }, events, held, queued };
}

export const TEST_ONLY = {
};
