import { UnavailableRpcValue } from '@/01-models/unavailable-rpc-value';

// This identity cannot be minted by persisted JSON. It is deliberately not a
// serialized envelope or an active endpoint DTO.
const retained = new WeakMap<object, UnavailableRpcValue>();

export function retainRpcEndpoint<T extends object>({ value, raw }: { value: T, raw: UnavailableRpcValue }): T {
  retained.set(value, raw.copy());
  return value;
}

export function retainedRpcEndpoint({ value }: { value: unknown }): UnavailableRpcValue | undefined {
  return typeof value === 'object' && value !== null ? retained.get(value) : undefined;
}

export function projectRetainedRpc({ value }: { value: unknown }): unknown {
  const leaf = retainedRpcLeaf({ value: value });
  if (leaf !== undefined) return leaf.json();
  const raw = retainedRpcEndpoint({ value: value });
  return raw === undefined ? value : { ...value as object, endpoint: raw.json() };
}

const leaves = new WeakMap<object, UnavailableRpcValue>();

export function retainRpcLeaf<T extends object>({ value, raw }: { value: T, raw: UnavailableRpcValue }): T {
  leaves.set(value, raw.copy());
  return value;
}

export function retainedRpcLeaf({ value }: { value: unknown }): UnavailableRpcValue | undefined {
  return typeof value === 'object' && value !== null ? leaves.get(value) : undefined;
}

export const TEST_ONLY = {
};
