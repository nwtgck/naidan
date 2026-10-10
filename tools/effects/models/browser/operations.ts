import { MESSAGING_OPERATIONS } from './messaging.ts';
import type ts from 'typescript';
import { DOM_OPERATIONS } from './dom.ts';
import type { ContractOwner, Value } from '../../analysis/values.ts';
import type { NativeModelContext } from '../invoke.ts';
import { applyOperation, indexOperations, type OperationAccess } from '../operation.ts';
import { STORAGE_MANAGER_OPERATIONS } from './storage-manager.ts';
import { WEB_STORAGE_OPERATIONS } from './web-storage.ts';
import { BROWSER_METADATA_OPERATIONS } from './metadata.ts';
import { FILE_SYSTEM_OPERATIONS } from './file-system.ts';
import { NETWORK_OPERATIONS } from './network.ts';
import { CACHE_OPERATIONS } from './cache-storage.ts';

/** An index of executable, co-located models, not an independent policy file. */
export const BROWSER_OPERATIONS = [
  ...STORAGE_MANAGER_OPERATIONS, ...WEB_STORAGE_OPERATIONS, ...BROWSER_METADATA_OPERATIONS,
  ...FILE_SYSTEM_OPERATIONS, ...NETWORK_OPERATIONS, ...CACHE_OPERATIONS, ...DOM_OPERATIONS, ...MESSAGING_OPERATIONS,
] as const;
const INDEX = indexOperations({ rules: BROWSER_OPERATIONS });

export function evaluateBrowserOperation({ context, callable, args, owner, node, access }: {
  context: NativeModelContext,
  callable: Extract<Value, { kind: 'native' }>,
  args: readonly Value[],
  owner: ContractOwner | undefined,
  node: ts.Node,
  access: OperationAccess,
}): Value | undefined {
  const rule = INDEX.get(`${access}:${callable.name}`);
  if (rule === undefined) return undefined; // Not the same thing as intentional-none.
  return applyOperation({ context, callable, args, owner, node, rule });
}
