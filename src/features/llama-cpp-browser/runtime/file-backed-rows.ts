import type { Core } from './core';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';

/** Optional extension, queried on the actual module, not inferred from a model
 * name or a package version. Old runtimes keep the eager-load behavior. */
export function fileBackedRowsCapability({ core }: { core: Core }) {
  core.assertIdle();
  const version: unknown = Reflect.get(core.module, '_lcb_file_backed_rows_version');
  if (version === undefined) return undefined;
  if (typeof version !== 'function') throw new LlamaCppBrowserError({ code: 'runtime-error' });
  const value: unknown = version();
  if (value === 0) return undefined;
  const query: unknown = Reflect.get(core.module, '_lcb_model_file_backed_shard');
  if (value !== 1 || core.pointerBytes !== 8 || typeof query !== 'function') throw new LlamaCppBrowserError({ code: 'runtime-error' });
  return {
    retainedShard({ model, count }: { model: bigint, count: number }): number | undefined {
      core.assertIdle();
      if (model === 0n || !Number.isSafeInteger(count) || count < 1) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      // Native metadata ABI: synchronous int32 result, -1 means no retained file.
      const index: unknown = query(model);
      if (index === -1) return undefined;
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= count) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      return index;
    },
  };
}

export const TEST_ONLY = {
};
