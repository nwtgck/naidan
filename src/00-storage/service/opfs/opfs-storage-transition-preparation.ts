type OpfsStorageTransitionPreparation = () => Promise<void>;

const preparations = new Set<OpfsStorageTransitionPreparation>();

/**
 * Registers application-owned cleanup that must finish before an OPFS storage
 * session releases its shared Web Lock for an encryption transition.
 *
 * The storage layer owns the synchronization point but does not import Wesh,
 * File Explorer, chat processing, or other application features. Callers may
 * keep those features code-split by registering a callback that imports them
 * only when a transition is requested.
 */
export function registerOpfsStorageTransitionPreparation({
  prepare,
}: {
  prepare: OpfsStorageTransitionPreparation,
}): () => void {
  preparations.add(prepare);
  return () => {
    preparations.delete(prepare);
  };
}

export async function prepareRegisteredOpfsStorageTransition(): Promise<void> {
  for (const prepare of preparations) {
    await prepare();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  preparations,
};
