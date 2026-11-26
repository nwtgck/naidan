import type { MeasurementLane, PerformanceStep } from './types';
import { libraryPrompt, shortPrompt } from './text-prompts';

export const swaCacheProtocol = 'swa-cache-en-v1';
export const swaCacheLanes = ['swa-full', 'swa-compact'] as const;
const longPrompt = libraryPrompt({ weeks: 32 });
const followUp = 'Add one staffing recommendation for the busiest times in the records.';

export function swaCacheModeForLane({ lane }: { lane: MeasurementLane | undefined }): 'full' | 'compact' | undefined {
  switch (lane) {
  case 'swa-full': return 'full';
  case 'swa-compact': return 'compact';
  case 'standard': case 'gpu-profile': case 'q2-baseline': case 'q2-gpu': case undefined: return undefined;
  default: {
    const exhaustive: never = lane;
    throw new Error(String(exhaustive));
  }
  }
}

export function swaCacheSteps({ modelCount, repeats, maxTokens }: { modelCount: number, repeats: number, maxTokens: number }): PerformanceStep[] {
  const steps: PerformanceStep[] = [];
  for (let modelIndex = 0; modelIndex < modelCount; modelIndex++) {
    for (const lane of swaCacheLanes) {
      const add = ({ scenario, position, repetition, prompt, limit, dependsOn }: {
        scenario: PerformanceStep['scenario'], position: PerformanceStep['position'], repetition: number, prompt: string, limit: number, dependsOn?: string,
      }): string => {
        const id = `m${modelIndex}-${steps.length}`;
        steps.push({
          id,
          modelIndex,
          lane,
          scenario,
          position,
          repetition,
          prompt,
          maxTokens: Math.min(maxTokens, limit),
          dependsOn,
          sequence: dependsOn === undefined ? 'fresh' : 'continue',
          role: 'measurement',
        });
        return id;
      };
      add({ scenario: 'initial', position: 'initial', repetition: 0, prompt: shortPrompt, limit: 8 });
      for (let repetition = 1; repetition <= repeats; repetition++) {
        add({ scenario: 'short', position: 'before', repetition, prompt: shortPrompt, limit: maxTokens });
        const parent = add({ scenario: 'long', position: 'workload', repetition, prompt: longPrompt, limit: 8 });
        add({ scenario: 'continuation', position: 'workload', repetition, prompt: followUp, limit: 16, dependsOn: parent });
        add({ scenario: 'short', position: 'after', repetition, prompt: shortPrompt, limit: maxTokens });
      }
    }
  }
  return steps;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
