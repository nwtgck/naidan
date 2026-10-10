import { createGenerationPerformance } from '@/features/llama-cpp-browser/worker/generation-performance';
import { createPerformancePlan } from '@/features/llama-cpp-browser/performance/plan';
import type { PerformanceSnapshot } from '@/features/llama-cpp-browser/performance/types';

export function performancePlan({ models = 1, repeats = 1, diagnostics = 'none' }: { models?: number, repeats?: number, diagnostics?: 'none' | 'placement' } = {}) {
  return createPerformancePlan({
    id: 'test_run',
    createdAt: '2026-10-01T00:00:00.000Z',
    models: Array.from({ length: models }, (_, index) => ({ id: `user/m${index}`, name: `model${index}.gguf`, size: 4096, importedAt: 1 })),
    settings: { repeats, diagnostics, maxTokens: 128, timeoutMs: 1000 },
    options: { profile: 'webgpu-wasm64-jspi' },
    notes: '',
  });
}

export function performanceReport({ reused = 0, outcome = 'completed' }: { reused?: number, outcome?: 'completed' | 'failed' | 'aborted' } = {}) {
  let time = 0;
  const metrics = createGenerationPerformance({ enabled: true, now: () => time });
  metrics.counters.reusedTokens = reused;
  metrics.counters.promptTokens = 32;
  metrics.counters.contextTokens = 4096;
  metrics.counters.prefillBatchTokens = 512;
  time = 100; metrics.sampled(); metrics.rendered({ endOfGeneration: false });
  time = 200; metrics.sampled(); metrics.rendered({ endOfGeneration: false });
  time = 230; metrics.sampled(); metrics.rendered({ endOfGeneration: true });
  return metrics.finish({ outcome, profile: 'webgpu-wasm64-jspi' })!;
}

export function performanceEnvironment(): PerformanceSnapshot['environment'] {
  return { appVersion: 'test', buildMode: 'hosted', userAgent: 'test', hardwareConcurrency: 8, crossOriginIsolated: true, timeOrigin: 1000 };
}

export const TEST_ONLY = {
};
