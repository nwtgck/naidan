import type { VisionAdmission } from './vision-admission-schema';
import { createVisionMeasurement } from '@/features/llama-cpp-browser/worker/vision-measurement';
import { resolvedModelFixture } from '@/features/llama-cpp-browser/worker/test-utils/resolved-model.test-support';

export function visionAdmission({ decision }: { decision: 'ready' | 'missing-projector' | 'native-no-vision' | 'failed' }): VisionAdmission {
  const outcome = (() => {
    switch (decision) {
    case 'ready': case 'missing-projector': case 'native-no-vision': return 'completed';
    case 'failed': return 'failed';
    default: {
      const exhaustive: never = decision;
      throw new Error(String(exhaustive));
    }
    }
  })();
  const diagnostic = createVisionMeasurement({ directory: resolvedModelFixture({ modelId: 'user/fixture' }).directory, now: () => 0 }).finish({ outcome });
  const base = { version: 1 as const, elapsedMs: 10, diagnostic };
  switch (decision) {
  case 'ready': return { ...base, status: 'ready', capability: 'native-vision' };
  case 'missing-projector': case 'native-no-vision': return { ...base, status: 'skipped', reason: decision };
  case 'failed': return { ...base, status: 'failed', error: 'runtime-error' };
  default: {
    const exhaustive: never = decision;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
