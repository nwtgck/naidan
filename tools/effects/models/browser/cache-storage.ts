import { UNKNOWN } from '../../analysis/values.ts';
import type { OperationRule } from '../operation.ts';
import { passiveArguments } from './guards.ts';

/** No default-to-write branch: future methods must receive an explicit decision. */
export const CACHE_OPERATIONS: readonly OperationRule[] = [
  {
    id: 'cache-storage.open',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['caches.open'],
    policy: { kind: 'tracked', effects: ['cachestorage.write'], reason: 'Opening creates the named content cache when absent.' },
    evaluate: input => {
      passiveArguments(input); return { kind: 'promise', value: input.context.native({ name: 'Cache', receiver: undefined }) };
    },
  },
  {
    id: 'cache-storage.read',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['caches.match', 'caches.has', 'caches.keys', 'Cache.match', 'Cache.matchAll', 'Cache.keys'],
    policy: { kind: 'tracked', effects: ['cachestorage.read'], reason: 'Explicit content-cache queries read stored entries or keys; this is not the automatic HTTP cache.' },
    evaluate: input => {
      passiveArguments(input); return { kind: 'promise', value: UNKNOWN };
    },
  },
  {
    id: 'cache-storage.write',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['caches.delete', 'Cache.delete', 'Cache.put'],
    policy: { kind: 'tracked', effects: ['cachestorage.write'], reason: 'Explicitly replacing or deleting cached content is a write.' },
    evaluate: input => {
      passiveArguments(input); return { kind: 'promise', value: UNKNOWN };
    },
  },
  {
    id: 'cache-storage.fetch-and-store',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['Cache.add', 'Cache.addAll'],
    policy: { kind: 'tracked', effects: ['cachestorage.write', 'network.http'], reason: 'add/addAll fetch a resource and store it: both effects belong to this operation.' },
    evaluate: input => {
      passiveArguments(input); return { kind: 'promise', value: UNKNOWN };
    },
  },
];
