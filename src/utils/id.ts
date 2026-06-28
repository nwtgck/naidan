import { nanoid } from 'nanoid';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Move this Naidan-specific helper into 01-models or application logic.
import type { NaidanId } from '@/01-models/ids';

export function generateId<TId extends NaidanId>(): TId {
  return nanoid() as unknown as TId;
}

export function generateOpaqueId(): string {
  return nanoid();
}
