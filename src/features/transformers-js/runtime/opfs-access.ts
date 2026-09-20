import { OPFS_MODELS_DIR } from '@/constants';
/** Cooperative locks cover the existing model storage, not the inference lane.
 * Every participant acquires root, model, file in that order. No lock stealing,
 * timeout-based release or shared-to-exclusive upgrade is permitted.
 */
const rootKey = 'naidan:transformers-js:opfs:models';

export class OpfsResourceBusyError extends Error {
  constructor() {
    super('The downloaded model resource is being changed by another operation');
    this.name = 'OpfsResourceBusyError';
  }
}

export function supportsOpfsCoordination(): boolean {
  // Only absence enables the legacy path. A getter/request failure propagates;
  // falling back after an API failure could race a cooperating peer.
  return navigator.locks !== undefined;
}

function canonicalParts({ path }: { path: string }): string[] {
  const parts = path.split('/').filter(part => part.length > 0);
  if (parts[0] !== OPFS_MODELS_DIR || parts.some(part => part === '.' || part === '..')) {
    throw new Error('Invalid model storage path');
  }
  return parts;
}

function modelNamespace({ parts }: { parts: string[] }): string {
  return parts.slice(0, parts[1] === 'user' || parts[1] === 'local' ? 3 : 4).join('/');
}

async function request<T>({ name, mode, availability, signal, run }: {
  name: string; mode: LockMode; availability: 'wait' | 'immediate';
  signal: AbortSignal | undefined; run: () => Promise<T>;
}): Promise<T> {
  let options: LockOptions;
  switch (availability) {
  case 'immediate': options = { mode, ifAvailable: true }; break;
  case 'wait': options = { mode, ...(signal === undefined ? {} : { signal }) }; break;
  default: {
    const exhaustive: never = availability;
    throw new Error(`Unhandled OPFS availability: ${exhaustive}`);
  }
  }
  signal?.throwIfAborted();
  return await navigator.locks.request(name, options, async lock => {
    if (lock === null) throw new OpfsResourceBusyError();
    signal?.throwIfAborted();
    return await run();
  });
}

const leases = new WeakMap<object, { path: string; mode: LockMode; active: boolean }>();
export type OpfsFileLease = { readonly coordinated: boolean };

export function assertOpfsFileLease({ lease, path, mode }: {
  lease: OpfsFileLease; path: string; mode: LockMode;
}): void {
  const held = leases.get(lease);
  const canonical = canonicalParts({ path }).join('/');
  if (held === undefined || !held.active || held.path !== canonical || (mode === 'exclusive' && held.mode !== 'exclusive')) {
    throw new Error('Model file access requires its active matching lease');
  }
}

export async function withOpfsFileLease<T>({ path, mode, availability, signal, run }: {
  path: string; mode: LockMode; availability: 'wait' | 'immediate';
  signal: AbortSignal | undefined; run: ({ lease }: { lease: OpfsFileLease }) => Promise<T>;
}): Promise<T> {
  signal?.throwIfAborted();
  const parts = canonicalParts({ path });
  const canonical = parts.join('/');
  const coordinated = supportsOpfsCoordination();
  const execute = async () => {
    const lease: OpfsFileLease = Object.freeze({ coordinated });
    const state = { path: canonical, mode, active: true };
    leases.set(lease, state);
    try {
      return await run({ lease });
    } finally {
      state.active = false;
    }
  };
  if (!coordinated) return await execute();
  // Local imports use models/user/<model>; remote paths include host/org/repo.
  const model = modelNamespace({ parts });
  return await request({ name: rootKey, mode: 'shared', availability, signal, run: async () =>
    await request({ name: `${rootKey}:model:${model}`, mode: 'shared', availability, signal, run: async () =>
      await request({ name: `${rootKey}:file:${canonical}`, mode, availability, signal, run: execute }) }) });
}

export async function withOpfsModelDeletion<T>({ modelPath, run }: {
  modelPath: string; run: () => Promise<T>;
}): Promise<T> {
  const parts = canonicalParts({ path: modelPath });
  const depth = parts[1] === 'user' || parts[1] === 'local' ? 3 : 4;
  if (parts.length !== depth) throw new Error('Model deletion requires its complete model directory path');
  const model = modelNamespace({ parts });
  if (model !== parts.join('/')) throw new Error('Model deletion requires its model directory path');
  if (!supportsOpfsCoordination()) return await run();
  return await request({ name: rootKey, mode: 'shared', availability: 'wait', signal: undefined, run: async () =>
    await request({ name: `${rootKey}:model:${model}`, mode: 'exclusive', availability: 'wait', signal: undefined, run }) });
}

/** Pure completion probe. The marker and File snapshot belong to one short
 * shared lease. Missing/empty is not permission to mutate while reading, and
 * permission/body-snapshot errors must not masquerade as cache absence.
 */
export async function readCompletedOpfsSnapshot({ path, lease }: {
  path: string; lease: OpfsFileLease;
}): Promise<File | undefined> {
  assertOpfsFileLease({ lease, path, mode: 'shared' });
  const parts = canonicalParts({ path });
  const name = parts.pop();
  if (name === undefined) throw new Error('Missing model filename');
  try {
    let directory = await navigator.storage.getDirectory();
    for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: false });
    await directory.getFileHandle(`.${name}.complete`, { create: false });
    const file = await (await directory.getFileHandle(name, { create: false })).getFile();
    return file.size > 0 ? file : undefined;
  } catch (error) {
    if ((error instanceof DOMException || error instanceof Error) && error.name === 'NotFoundError') return undefined;
    throw error;
  }
}

/** Parent deletion owns the entire model namespace, including empty-parent
 * cleanup. It must never upgrade a root shared lease while holding it.
 */
export async function withOpfsRootDeletion<T>({ run }: { run: () => Promise<T> }): Promise<T> {
  if (!supportsOpfsCoordination()) return await run();
  return await request({ name: rootKey, mode: 'exclusive', availability: 'wait', signal: undefined, run });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
