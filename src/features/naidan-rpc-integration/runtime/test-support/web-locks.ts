import { vi } from 'vitest';

/** Model the Web Locks argument check and delayed callback separately. A
 * permissive request mock would hide an invalid signal/ifAvailable pairing. */
export function createWebLocksFixture() {
  let held = false;
  const requests: (() => void)[] = [];
  const request = vi.fn((_name: string, options: LockOptions, callback: LockGrantedCallback<unknown>): Promise<unknown> => {
    if (options.signal && (options.ifAvailable || options.steal)) return Promise.reject(new DOMException('signal cannot accompany ifAvailable or steal', 'NotSupportedError'));
    const completion = Promise.withResolvers<unknown>();
    requests.push(() => {
      const grant = !held;
      if (grant) held = true;
      // null is mandated by the native Web Locks callback for an unavailable lock.
      const lock = grant ? { name: 'naidan-peer-rpc-owner/v1', mode: 'exclusive' as const } : null;
      Promise.resolve(callback(lock)).then(value => {
        if (grant) held = false;
        completion.resolve(value);
      }, error => {
        if (grant) held = false;
        completion.reject(error);
      });
    });
    return completion.promise;
  });
  vi.stubGlobal('navigator', { locks: { request } });
  return {
    request,
    held: () => held,
    dispatch() {
      const next = requests.shift();
      next?.();
    },
  };
}

export const TEST_ONLY = {
};
