import { projectRetainedRpc } from '@/00-storage/00-dto/retained-rpc';

/** Call only after DTO schema validation, and before acquiring write ownership. */
export function stringifyStorageDto({ value, space }: { value: unknown, space: number | undefined }): string {
  const serialized = JSON.stringify(value, (_key, child: unknown) => projectRetainedRpc({ value: child }), space);
  if (serialized === undefined) throw new Error('Storage DTO has no JSON representation');
  return serialized;
}

export const TEST_ONLY = {
};
