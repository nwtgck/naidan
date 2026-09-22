import type { MessageNode } from '@/01-models/types';

const keys = new WeakMap<MessageNode['parts'][number], string>();
let nextKey = 0;

/** View identity follows the in-memory part across insertions, never stored data. */
export function getMessagePartDisplayKey({ part }: { part: MessageNode['parts'][number] }): string {
  let key = keys.get(part);
  if (key === undefined) {
    key = `part-view-${nextKey++}`;
    keys.set(part, key);
  }
  return key;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
