import { SCALAR, UNKNOWN } from '../../analysis/values.ts';
import type { OperationRule } from '../operation.ts';
import { scalarArguments } from './guards.ts';

/** Exact members, not a blanket effect for the whole factory or request object. */
export const BROWSER_METADATA_OPERATIONS: readonly OperationRule[] = [
  {
    id: 'indexeddb.compare',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['indexedDB.cmp'],
    policy: { kind: 'intentional-none', reason: 'Key comparison does not access a database; coercion guards remain required.' },
    evaluate: input => {
      scalarArguments(input); return SCALAR;
    },
  },
  {
    id: 'indexeddb.databases',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['indexedDB.databases'],
    policy: { kind: 'tracked', effects: ['indexeddb.read'], reason: 'Listing application databases observes stored content names, without creating or upgrading them.' },
    evaluate: input => {
      scalarArguments(input); return { kind: 'promise', value: UNKNOWN };
    },
  },
  {
    id: 'indexeddb.open',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['indexedDB.open'],
    policy: { kind: 'tracked', effects: ['indexeddb.read', 'indexeddb.write'], reason: 'Opening may create or upgrade a database; no existence/version history is assumed.' },
    evaluate: input => {
      scalarArguments(input); return input.context.native({ name: 'IDBRequest', receiver: undefined });
    },
  },
  {
    id: 'indexeddb.delete',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['indexedDB.deleteDatabase'],
    policy: { kind: 'tracked', effects: ['indexeddb.write'], reason: 'Database deletion is a write; browser-internal management reads are not a separate content effect.' },
    evaluate: input => {
      scalarArguments(input); return input.context.native({ name: 'IDBRequest', receiver: undefined });
    },
  },
  {
    id: 'xhr.construct',
    definedIn: import.meta.url,
    access: 'construct',
    targets: ['XMLHttpRequest'],
    policy: { kind: 'intentional-none', reason: 'Constructing an in-memory request does not send it.' },
    evaluate: input => {
      scalarArguments(input); return input.context.native({ name: 'XMLHttpRequest', receiver: undefined });
    },
  },
  {
    id: 'xhr.headers',
    definedIn: import.meta.url,
    access: 'call',
    targets: [
      'XMLHttpRequest.getResponseHeader', 'XMLHttpRequest.getAllResponseHeaders', 'XMLHttpRequest.setRequestHeader', 'XMLHttpRequest.overrideMimeType',
    ],
    policy: { kind: 'intentional-none', reason: 'In-memory request configuration and available response headers are not new network I/O.' },
    evaluate: input => {
      scalarArguments(input); return SCALAR;
    },
  },
  {
    id: 'xhr.control',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['XMLHttpRequest.open', 'XMLHttpRequest.abort'],
    policy: { kind: 'tracked', effects: ['network.http'], reason: 'open/abort can terminate an existing fetch; retain a history-independent control upper bound.' },
    evaluate: input => {
      scalarArguments(input); return SCALAR;
    },
  },
  {
    id: 'xhr.send',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['XMLHttpRequest.send'],
    policy: { kind: 'tracked', effects: ['network.http'], reason: 'Sending a request initiates network I/O. Scalar bodies only in this model.' },
    evaluate: input => {
      scalarArguments(input); return SCALAR;
    },
  },
];
