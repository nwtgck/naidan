import type { SpeechLoadProgress } from '@/features/speech-cpp-browser/types';

export const modelLoadEstimateMethod = 'fixed_stage_weights';
export const modelLoadStageWeights = { runtime: 20, checkingModel: 20, nativeModel: 50, checkingLoadedModel: 10 } as const;
type LoadGroup = keyof typeof modelLoadStageWeights;

/** Fixed work allocation, not a prediction of remaining time. Native reads
 * reserve part of their allocation for work that file I/O cannot observe. */
export function createModelLoadEstimate() {
  const seen = new Set<LoadGroup>();
  const completed = new Set<LoadGroup>();
  let estimate: number | undefined;
  function enter({ group, fraction }: { group: LoadGroup, fraction: number | undefined }): number | undefined {
    switch (group) {
    case 'runtime':
      if (seen.has('checkingModel')) {
        completed.add('checkingModel');
      }
      break;
    case 'checkingModel':
      if (seen.has('runtime')) {
        completed.add('runtime');
      }
      break;
    case 'nativeModel': completed.add('runtime');
      completed.add('checkingModel');
      break;
    case 'checkingLoadedModel': completed.add('runtime');
      completed.add('checkingModel');
      completed.add('nativeModel');
      break;
    default: {
      const exhaustive: never = group;
      throw new Error(String(exhaustive));
    }
    }
    seen.add(group);
    let value = 0;
    for (const done of completed) {
      value += modelLoadStageWeights[done];
    }
    if (!completed.has(group) && fraction !== undefined) {
      value += modelLoadStageWeights[group] * Math.min(1, Math.max(0, fraction));
    }
    if (value > 0 || fraction !== undefined) {
      estimate = Math.min(99, Math.max(estimate ?? 0, value));
    }
    return estimate;
  }
  return {
    update({ progress, ready }: { progress: SpeechLoadProgress | undefined, ready: boolean }): number | undefined {
      if (ready) {
        estimate = 100;
        return estimate;
      }
      switch (progress?.stage) {
      case 'preparing_runtime': return enter({ group: 'runtime', fraction: undefined });
      case 'loading_runtime': {
        const { stage: _stage, fetchedBytes: _fetchedBytes, decompressedBytes, totalDecompressedBytes, ...unhandled } = progress;
        unhandled satisfies Record<PropertyKey, never>;
        return enter({ group: 'runtime', fraction: totalDecompressedBytes > 0 ? decompressedBytes / totalDecompressedBytes : undefined });
      }
      case 'checking_model': return enter({ group: 'checkingModel', fraction: undefined });
      case 'preparing_model': return enter({ group: 'nativeModel', fraction: undefined });
      case 'reading_model': {
        const { stage: _stage, readBytes, totalBytes, ...unhandled } = progress;
        unhandled satisfies Record<PropertyKey, never>;
        return enter({ group: 'nativeModel', fraction: totalBytes > 0 ? readBytes / totalBytes * 0.9 : undefined });
      }
      case 'checking_loaded_model': return enter({ group: 'checkingLoadedModel', fraction: undefined });
      case undefined: return estimate;
      default: {
        const exhaustive: never = progress;
        throw new Error(String(exhaustive));
      }
      }
    },
    reset(): void {
      seen.clear();
      completed.clear();
      estimate = undefined;
    },
  };
}

export const TEST_ONLY = {
};
