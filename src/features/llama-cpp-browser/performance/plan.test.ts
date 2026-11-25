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

it('keeps the bounded baseline and adds a tool round trip once per model', () => {
  const source = performancePlan();
  const plan = createPerformancePlan({ ...source, settings: { ...source.settings, repeats: 1, maxTokens: 64, diagnostics: 'placement' } });
  expect(plan.steps.slice(0, 6).map(step => [step.scenario, step.position, step.maxTokens])).toEqual([
    ['initial', 'initial', 8], ['short', 'before', 64], ['continuation', 'workload', 16],
    ['long', 'workload', 8], ['short', 'after', 64], ['placement', 'diagnostic', 2],
  ]);
  expect(plan.steps.slice(0, 6).reduce((sum, step) => sum + step.maxTokens, 0)).toBe(162);
  expect(plan.steps[2]!.dependsOn).toBe(plan.steps[1]!.id);
  expect(plan.steps[4]!.prompt).toBe(plan.steps[1]!.prompt);
  expect(plan.steps[4]!.sequence).toBe('fresh');
  expect(plan.protocol).toBe('targeted-text-en-v5');
  expect(plan.steps.slice(6)).toMatchObject([
    { scenario: 'tool-call', sequence: 'fresh', role: 'preparation', maxTokens: 512 },
    { scenario: 'tool-continuation', sequence: 'continue', role: 'measurement', dependsOn: plan.steps[6]!.id, maxTokens: 32 },
  ]);
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

it('requires identical input in both Q2 lanes and a placement observation after the speed trials', () => {
  const source = performancePlan({ models: 2, repeats: 2, mode: 'both' });
  const plan = createPerformancePlan({ ...source, settings: { ...source.settings, q2Placement: 'ab' }, options: { profile: 'cpu-wasm32' } });
  expect(plan.options.profile).toBe('webgpu-wasm64-jspi');
  expect(plan.steps).toHaveLength(32);
  for (const modelIndex of [0, 1]) {
    const steps = plan.steps.filter(step => step.modelIndex === modelIndex);
    expect(steps.map(step => [step.lane, step.scenario])).toEqual(['q2-baseline', 'q2-gpu'].flatMap(lane =>
      ['initial', 'short', 'long', 'short', 'short', 'long', 'short', 'placement'].map(scenario => [lane, scenario])));
  }
  expect(planSchema.safeParse({ ...plan, steps: plan.steps.slice(1) }).success).toBe(false);
  expect(planSchema.safeParse({
    ...plan,
    steps: plan.steps.map((step, index) => index === 8 ? { ...step, prompt: 'different input' } : step),
  }).success).toBe(false);
  expect(planSchema.safeParse({ ...plan, options: { profile: 'cpu-wasm32' } }).success).toBe(false);
});

it('compares both SWA modes with identical ordered long inputs and lane-local continuations', () => {
  const source = performancePlan({ models: 2, repeats: 2 });
  const plan = createPerformancePlan({ ...source, settings: { ...source.settings, swaCache: 'ab' } });
  expect(plan).toMatchObject({ protocol: 'swa-cache-en-v1', settings: { mode: 'standard', diagnostics: 'none', swaCache: 'ab' }, options: { profile: 'webgpu-wasm64-jspi' } });
  expect(plan.steps).toHaveLength(36);
  for (const modelIndex of [0, 1]) {
    const full = plan.steps.filter(step => step.modelIndex === modelIndex && step.lane === 'swa-full');
    const compact = plan.steps.filter(step => step.modelIndex === modelIndex && step.lane === 'swa-compact');
    expect(full.map(step => step.scenario)).toEqual(['initial', 'short', 'long', 'continuation', 'short', 'short', 'long', 'continuation', 'short']);
    expect(full[2]?.prompt).toContain('Week 32:');
    expect(full[3]?.dependsOn).toBe(full[2]?.id);
    expect(compact[3]?.dependsOn).toBe(compact[2]?.id);
    expect(compact.map(step => [step.scenario, step.prompt, step.maxTokens])).toEqual(full.map(step => [step.scenario, step.prompt, step.maxTokens]));
  }
  const steps = plan.steps.map((step, index) => index === 12 ? { ...step, dependsOn: plan.steps[2]!.id } : step);
  expect(planSchema.safeParse({ ...plan, steps }).success).toBe(false);
  expect(planSchema.safeParse({ ...plan, settings: { ...plan.settings, q2Placement: 'ab' } }).success).toBe(false);
});

it.each(['standard', 'gpu-profile', 'both'] as const)('keeps the tool result adjacent to its real call and in one lane in %s mode', mode => {
  const plan = performancePlan({ models: 2, repeats: 3, mode, workload: 'tool-continuation' });
  const pairs = plan.steps.filter(step => step.scenario === 'tool-call' || step.scenario === 'tool-continuation');
  const lane = mode === 'gpu-profile' ? 'gpu-profile' : 'standard';
  expect(pairs).toMatchObject([
    { modelIndex: 0, lane, scenario: 'tool-call' },
    { modelIndex: 0, lane, scenario: 'tool-continuation', dependsOn: pairs[0]!.id },
    { modelIndex: 1, lane, scenario: 'tool-call' },
    { modelIndex: 1, lane, scenario: 'tool-continuation', dependsOn: pairs[2]!.id },
  ]);
  expect(planSchema.safeParse({ ...plan, steps: plan.steps.filter(step => step.id !== pairs[3]!.id) }).success).toBe(false);
});
