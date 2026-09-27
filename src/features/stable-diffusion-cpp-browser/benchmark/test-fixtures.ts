import { artifactFixture, ggufFile, parametersFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import { createBenchmarkPlan } from './plan';
import type { ImageBenchmarkTarget } from '@/features/stable-diffusion-cpp-browser/library-view';
import type { BenchmarkProtocol } from './types';
import type { ImageDiagnostic } from '@/features/stable-diffusion-cpp-browser/diagnostics';

export function targetFixture({ id }: { id: string }): ImageBenchmarkTarget {
  return { id, label: `model-${id}.gguf`, detail: `user/${id}/model.gguf`, facts: { family: 'sd-checkpoint', variant: 'unknown', evidence: ['synthetic fixture'] },
    composition: 'automatic', components: [], models: [{ slot: 'model', path: 'model.gguf', file: ggufFile() }], missing: [], issue: undefined };
}
export function planFixture({ mode, repeats }: { mode: BenchmarkProtocol['mode'], repeats: number }) {
  return createBenchmarkPlan({ id: 'test-session', createdAt: '2026-09-27T00:00:00.000Z', appVersion: 'test', notes: '',
    protocol: { mode, repeats, cooldownSeconds: 0, timeoutSeconds: 0, order: 'listed', keepImages: false },
    targets: [targetFixture({ id: 'a' }), targetFixture({ id: 'b' })], common: parametersFixture(), overrides: {}, loras: {}, strategy: 'shared',
    artifact: artifactFixture(), baseUrl: 'https://test.invalid/app/', preview: { enabled: false, interval: 2, startStep: 1, mode: 'vae', maxEdge: 256 },
    weightResidency: 'auto', gpuBudgetMiB: undefined });
}
export function metricFixture({ metric, fields }: { metric: string, fields: ImageDiagnostic['fields'] }): ImageDiagnostic {
  return { event: 'native', stage: 'sampling', elapsedMs: 10, fields: { metric, perfVersion: 1, ...fields } };
}
export const TEST_ONLY = {
};
