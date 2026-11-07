/** Deterministic exclusive Web Lock queue. It models callback lifetime and both
 * request overloads, not native tab suspension, crashes, or browser permissions.
 */
export function createWorkflowTestLocks() {
  type Request = {
    name: string,
    callback: LockGrantedCallback<unknown>,
    resolve: ReturnType<typeof Promise.withResolvers<unknown>>['resolve'],
    reject: ReturnType<typeof Promise.withResolvers<unknown>>['reject'],
  };
  const held = new Set<string>();
  const queued: Request[] = [];
  const events: string[] = [];
  let releaseHook: (() => Promise<void>) | undefined;
  function drain(): void {
    for (const item of [...queued]) {
      if (held.has(item.name)) {
        continue;
      }
      queued.splice(queued.indexOf(item), 1);
      held.add(item.name);
      events.push(`grant:${item.name}`);
      const release = async () => {
        const hook = releaseHook;
        releaseHook = undefined;
        try {
          await hook?.();
        } finally {
          held.delete(item.name);
          events.push(`release:${item.name}`);
          drain();
        }
      };
      void Promise.resolve().then(() => item.callback({ name: item.name, mode: 'exclusive' })).then(async value => {
        await release();
        item.resolve(value);
      }, async reason => {
        await release();
        item.reject(reason);
      }).catch(item.reject);
    }
  }
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the native overloaded LockManager.request test boundary.
  const request = (name: string, optionsOrCallback: LockOptions | LockGrantedCallback<unknown>, callback: LockGrantedCallback<unknown> | undefined): Promise<unknown> => new Promise((resolve, reject) => {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const operation = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    if (!operation || options.steal || options.signal || (options.mode !== undefined && options.mode !== 'exclusive')) {
      throw new Error('Unsupported Workflow lock test request.');
    }
    if (options.ifAvailable && (held.has(name) || queued.some(item => item.name === name))) {
      events.push(`unavailable:${name}`);
      void Promise.resolve().then(() => operation(null)).then(resolve, reject);
      return;
    }
    queued.push({ name, callback: operation, resolve, reject });
    drain();
  });
  // The stand-in implements both overloads; its shared queue erases result types.
  return {
    locks: { request: request as LockManager['request'] },
    held,
    queued,
    events,
    beforeRelease({ hook }: { hook: () => Promise<void> }) {
      releaseHook = hook;
    },
  };
}

export const TEST_ONLY = {
};
