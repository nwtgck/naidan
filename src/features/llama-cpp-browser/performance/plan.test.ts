// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { performancePlan } from '@/features/llama-cpp-browser/test-utils/performance.test-support';
import { createPerformancePlan } from './plan';
import { planSchema } from './types';

describe('versioned English performance workload', () => {
  it('uses fixed English inputs for every step, independent of UI locale', () => {
    const plan = performancePlan({ models: 2, repeats: 3 });
    expect(plan.protocol).toBe('targeted-text-en-v4');
    for (const step of plan.steps) {
      expect(step.prompt).toContain('English');
      expect(Array.from(step.prompt).every(character => character.charCodeAt(0) < 128)).toBe(true);
    }
    const first = plan.steps.filter(step => step.modelIndex === 0);
    const second = plan.steps.filter(step => step.modelIndex === 1);
    expect(first.map(step => step.prompt)).toEqual(second.map(step => step.prompt));
    const short = first.find(step => step.scenario === 'short')!;
    const long = first.find(step => step.scenario === 'long')!;
    expect(long.prompt.length).toBeGreaterThan(short.prompt.length * 10);
    expect(first.filter(step => step.scenario === 'short').every(step => step.prompt === short.prompt)).toBe(true);
    expect(first.filter(step => step.scenario === 'long').every(step => step.prompt === long.prompt)).toBe(true);
  });

  it('does not silently label the old Japanese workload as the new English protocol', () => {
    expect(planSchema.safeParse({ ...performancePlan(), protocol: 'standard-text-v1' }).success).toBe(false);
  });
});

it('uses six bounded calls with separate placement and a measured continuation parent', () => {
  const source = performancePlan();
  const plan = createPerformancePlan({ ...source, settings: { ...source.settings, repeats: 1, maxTokens: 64, diagnostics: 'placement' } });
  expect(plan.steps.map(step => [step.scenario, step.position, step.maxTokens])).toEqual([
    ['initial', 'initial', 8], ['short', 'before', 64], ['continuation', 'workload', 16],
    ['long', 'workload', 8], ['short', 'after', 64], ['placement', 'diagnostic', 2],
  ]);
  expect(plan.steps.reduce((sum, step) => sum + step.maxTokens, 0)).toBe(162);
  expect(plan.steps[2]!.dependsOn).toBe(plan.steps[1]!.id);
  expect(plan.steps[4]!.prompt).toBe(plan.steps[1]!.prompt);
  expect(plan.steps[4]!.sequence).toBe('fresh');
});

describe('standard and profiling workload lanes', () => {
  it.each(['standard', 'gpu-profile', 'both'] as const)('builds complete identical workloads for %s', mode => {
    const plan = performancePlan({ models: 2, repeats: 3, diagnostics: 'placement', mode });
    expect(plan.steps).toHaveLength(2 * 14 * (mode === 'both' ? 2 : 1));
    expect(new Set(plan.steps.map(step => step.id)).size).toBe(plan.steps.length);
    expect(plan.options.profile).toBe('webgpu-wasm64-jspi');
    for (const step of plan.steps) {
      if (step.dependsOn) {
        const parent = plan.steps.find(candidate => candidate.id === step.dependsOn)!;
        expect(parent.modelIndex).toBe(step.modelIndex);
        expect(parent.lane).toBe(step.lane);
        expect(plan.steps.indexOf(parent)).toBeLessThan(plan.steps.indexOf(step));
      }
    }
    if (mode === 'both') {
      for (let modelIndex = 0; modelIndex < 2; modelIndex++) {
        const normal = plan.steps.filter(step => step.modelIndex === modelIndex && step.lane === 'standard');
        const diagnostic = plan.steps.filter(step => step.modelIndex === modelIndex && step.lane === 'gpu-profile');
        expect(normal.map(step => [step.scenario, step.position, step.repetition, step.prompt, step.maxTokens, step.sequence])).toEqual(diagnostic.map(step => [step.scenario, step.position, step.repetition, step.prompt, step.maxTokens, step.sequence]));
      }
    }
  });
});
