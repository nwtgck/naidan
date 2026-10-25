import { createTokenSpeedMeter, LIVE_SPEED_INTERVAL_MS } from '@/logic/generation-metrics/measurement';
import type { GenerationCallback } from '@/features/llama-cpp-browser/types';

/** One tiny, optional notification in flight. Never await telemetry on the decode path. */
export function createGenerationSpeedTracker({ onEvent }: { onEvent: GenerationCallback }) {
  const meter = createTokenSpeedMeter();
  let lastPublished = -Infinity;
  let pending = false;
  return {
    sample({ sampledAt, endOfGeneration }: { sampledAt: number, endOfGeneration: boolean }): void {
      if (endOfGeneration) {
        return;
      }
      meter.sample({ now: sampledAt });
      if (pending || sampledAt - lastPublished < LIVE_SPEED_INTERVAL_MS) {
        return;
      }
      const metrics = meter.snapshot({ live: true });
      if (metrics === undefined) {
        return;
      }
      pending = true;
      lastPublished = sampledAt;
      try {
        void Promise.resolve(onEvent({ event: { type: 'generation_metrics', metrics } })).catch(() => {}).finally(() => {
          pending = false;
        });
      } catch {
        pending = false;
      }
    },
    finish() {
      return meter.snapshot({ live: false });
    },
  };
}

export const TEST_ONLY = {
};
