import { nanoid } from 'nanoid';
import type { NaidanId } from '@/01-models/ids';

export function generateId<TId extends NaidanId>(): TId {
  return nanoid() as unknown as TId;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
