import { nanoid } from 'nanoid';

export function generateId<T extends string>(): T {
  return nanoid<T>();
}
