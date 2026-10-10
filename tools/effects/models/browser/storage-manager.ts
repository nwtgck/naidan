import { SCALAR } from '../../analysis/values.ts';
import type { OperationRule } from '../operation.ts';

/**
 * Naidan tracks application content reads/writes and network I/O, not every
 * browser state change. These three operations are intentionally outside that
 * vocabulary. In particular persist() MAY request permission/change retention;
 * none does not mean pure, inert, guaranteed success, or no permission prompt.
 * These are local primitive policies, not function-level UNSAFE suppressions.
 * Source: https://storage.spec.whatwg.org/#storagemanager
 */
export const STORAGE_MANAGER_OPERATIONS: readonly OperationRule[] = [
  {
    id: 'storage-manager.persisted',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['navigator.storage.persisted'],
    policy: { kind: 'intentional-none', reason: 'Persistence-status inspection is outside tracked application-content I/O; intentionally no effect.' },
    // No Web IDL argument conversion: this operation has no parameters. Extra
    // argument expressions are still evaluated by the analyzer before dispatch.
    evaluate: () => ({ kind: 'promise', value: SCALAR }),
  },
  {
    id: 'storage-manager.estimate',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['navigator.storage.estimate'],
    policy: { kind: 'intentional-none', reason: 'Quota and usage estimates are browser accounting, not application-content reads; intentionally no effect.' },
    evaluate: () => ({
      kind: 'promise',
      value: {
        kind: 'record',
        shape: 'open',
        reflected: undefined,
        indexValue: undefined,
        // Do not infer that extensions cannot exist from these two standard fields.
        fields: new Map(['usage', 'quota'].map(key => [key, { value: SCALAR, access: 'writable' as const }])),
      },
    }),
  },
  {
    id: 'storage-manager.persist',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['navigator.storage.persist'],
    policy: { kind: 'intentional-none', reason: 'A persistence permission/retention request may change browser policy, but is intentionally outside application-content writes and network I/O.' },
    evaluate: () => ({ kind: 'promise', value: SCALAR }),
  },
  {
    id: 'storage-manager.get-directory',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['navigator.storage.getDirectory'],
    policy: { kind: 'tracked', effects: ['opfs.read'], reason: 'Obtaining the origin-private content root remains a tracked read; the metadata/policy exception does not cover OPFS.' },
    evaluate: ({ context }) => ({ kind: 'promise', value: context.native({ name: 'opfs.directory', receiver: undefined }) }),
  },
];
