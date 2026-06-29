import { nanoid } from 'nanoid';
import type { NaidanId } from '@/01-models/ids';

export function generateId<TId extends NaidanId>(): TId {
  return nanoid() as unknown as TId;
}

export function generateOpaqueId(): string {
  return nanoid();
}
