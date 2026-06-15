import { nanoid } from 'nanoid';
import type { NaidanId } from '@/models/ids';

export function generateId<TId extends NaidanId>(): TId {
  return nanoid() as TId;
}

export function generateOpaqueId(): string {
  return nanoid();
}
