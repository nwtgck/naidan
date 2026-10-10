import { SCALAR } from '../../analysis/values.ts';
import type { OperationRule } from '../operation.ts';
import { scalarArguments } from './guards.ts';

/**
 * Storage has no LegacyOverrideBuiltIns: standard prototype members hide named
 * getters even when a stored key has the same name. Keep this exact list rather
 * than exempting arbitrary future members or inspecting the tool host's prototype.
 * Source: https://webidl.spec.whatwg.org/#dfn-named-property-visibility
 */
const STORAGE_MEMBERS = new Set([
  'length', 'key', 'getItem', 'setItem', 'removeItem', 'clear',
  'constructor', 'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty',
  'isPrototypeOf', 'propertyIsEnumerable', '__proto__', '__defineGetter__',
  '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
]);

export function webStorageReadOperation({ storage, key }: { storage: string, key: string }): string | undefined {
  if (storage !== 'localStorage' && storage !== 'sessionStorage') return undefined;
  return `${storage}.${STORAGE_MEMBERS.has(key) ? key : '[stored-key]'}`;
}

/** Same semantics for both stores; session lifetime is not an effect exemption. */
export const WEB_STORAGE_OPERATIONS: readonly OperationRule[] = [
  ...(['localStorage', 'sessionStorage'] as const).map(storage => ({
    id: `window.${storage}`,
    definedIn: import.meta.url,
    access: 'read',
    targets: [`Window.${storage}`],
    policy: { kind: 'intentional-none', reason: 'Obtaining the native storage handle does not read or write stored content.' },
    evaluate: input => input.context.native({ name: storage, receiver: undefined }),
  } satisfies OperationRule)),
  ...(['localStorage', 'sessionStorage'] as const).flatMap(storage => {
    const effect = (() => {
      switch (storage) {
      case 'localStorage': return 'localstorage';
      case 'sessionStorage': return 'sessionstorage';
      default: { const exhaustive: never = storage; throw new Error(String(exhaustive)); }
      }
    })();
    return [
      {
        id: `${effect}.read-method`,
        definedIn: import.meta.url,
        access: 'call',
        targets: ['getItem', 'key'].map(method => `${storage}.${method}`),
        policy: { kind: 'tracked', effects: [`${effect}.read`], reason: 'Reading a stored value or key is application-content access.' },
        evaluate: input => {
          scalarArguments(input); return SCALAR;
        },
      },
      {
        id: `${effect}.write-method`,
        definedIn: import.meta.url,
        access: 'call',
        targets: ['setItem', 'removeItem', 'clear'].map(method => `${storage}.${method}`),
        policy: { kind: 'tracked', effects: [`${effect}.write`], reason: 'Creating, replacing, removing or clearing stored content is a write.' },
        evaluate: input => {
          scalarArguments(input); return SCALAR;
        },
      },
      {
        id: `${effect}.length`,
        definedIn: import.meta.url,
        access: 'read',
        targets: [`${storage}.length`],
        policy: { kind: 'tracked', effects: [`${effect}.read`], reason: 'Key count observes application-content storage, unlike browser quota accounting.' },
        evaluate: () => SCALAR,
      },
      {
        id: `${effect}.property-read`,
        definedIn: import.meta.url,
        access: 'read',
        targets: [`${storage}.[stored-key]`],
        policy: { kind: 'tracked', effects: [`${effect}.read`], reason: 'Named-property retrieval observes stored content just as getItem does; standard prototype members remain separate.' },
        evaluate: () => SCALAR,
      },
      {
        // Internal name chosen only after the analyzer has resolved a real Storage receiver.
        id: `${effect}.property-write`,
        definedIn: import.meta.url,
        access: 'write',
        targets: [`${storage}.[stored-key]`],
        policy: { kind: 'tracked', effects: [`${effect}.write`], reason: 'Named-property writes to Web Storage are still content writes.' },
        evaluate: input => {
          scalarArguments(input); return SCALAR;
        },
      },
    ] satisfies readonly OperationRule[];
  }),
  {
    id: 'cookie.read',
    definedIn: import.meta.url,
    access: 'read',
    targets: ['document.cookie'],
    policy: { kind: 'tracked', effects: ['cookie.read'], reason: 'Explicit cookie retrieval reads application-visible persisted content.' },
    evaluate: () => SCALAR,
  },
  {
    id: 'cookie.write',
    definedIn: import.meta.url,
    access: 'write',
    targets: ['document.cookie'],
    policy: { kind: 'tracked', effects: ['cookie.write'], reason: 'Explicit cookie assignment changes application-visible persisted content.' },
    evaluate: input => {
      scalarArguments(input); return SCALAR;
    },
  },
];
