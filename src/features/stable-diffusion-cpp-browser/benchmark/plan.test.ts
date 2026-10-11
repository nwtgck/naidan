// @vitest-environment node
import { expect, it } from 'vitest';
import { createBenchmarkPlan, benchmarkParameters } from './plan';
import { planFixture, targetFixture } from './test-fixtures';
import { parametersFixture, artifactFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import type { ImageLoraSelection } from '@/features/stable-diffusion-cpp-browser/lora-form';

const input = () => ({
  id: 'batch',
  createdAt: 'now',
  appVersion: 'test',
  notes: '',
  protocol: { mode: 'cold-warm', repeats: 3, cooldownSeconds: 0, timeoutSeconds: 0, keepImages: false, order: 'listed' },
  targets: [targetFixture({ id: 'a' })],
  common: parametersFixture(),
  overrides: {},
  loras: {},
  imageInputs: {},
  strategy: 'shared' as const,
  artifact: artifactFixture(),
  baseUrl: 'https://app.test/',
  preview: { enabled: false, mode: 'vae' as const, interval: 2, startStep: 1, maxEdge: 256 },
  weightResidency: 'auto' as const,
  gpuBudgetMiB: undefined,
});

it('freezes effective values before work; shared form edits do not alter a captured plan', () => {
  const options = input(); const plan = createBenchmarkPlan(options);
  options.common.steps = 99; options.targets[0]!.models![0]!.path = 'other.gguf'; options.preview.enabled = true; options.protocol.repeats = 10;
  expect(plan.models[0]!.request.parameters.steps).toBe(20); expect(plan.models[0]!.request.models[0]!.path).toBe('model.gguf');
  expect(plan.models[0]!.request.preview.enabled).toBe(false); expect(plan.protocol.repeats).toBe(3);
});

it('overrides only selected parameters and keeps common prompts/size/steps after model-specific defaults', () => {
  const target = targetFixture({ id: 'turbo' }); target.facts = { family: 'z-image', variant: 'turbo', evidence: [] };
  const common = { ...parametersFixture(), width: 512, steps: 12 };
  const result = benchmarkParameters({ common, target, strategy: 'model-defaults', overrides: { seed: '77' } });
  expect(result.parameters).toMatchObject({ width: 512, steps: 12, guidance: 1, seed: '77', prompt: common.prompt });
  expect(result.preset).toBe('z-image-turbo');
});

it('applies only guidance from the partial Qwen Turbo recommendation during benchmarks', () => {
  const target = targetFixture({ id: 'qwen-turbo' }); target.facts = { family: 'qwen-image-2.1', variant: 'turbo', evidence: [] };
  const common = { ...parametersFixture(), width: 640, height: 768, steps: 17, guidance: 6, sampler: 'dpm++2m' as const, scheduler: 'karras' as const, modelArguments: 'custom=1' };
  const result = benchmarkParameters({ common, target, strategy: 'model-defaults', overrides: {} });
  expect(result.preset).toBe('qwen-image-2.1-turbo');
  expect(result.parameters).toEqual({ ...common, guidance: 1 });
});

it.each([-1, 0, 1.5, 11, NaN])('rejects invalid repeat count %s before creating a Worker', repeats => {
  const options = input(); options.protocol.repeats = repeats; expect(() => createBenchmarkPlan(options)).toThrow();
});

it('rejects random seeds, too many runs and incomplete targets without substituting defaults', () => {
  const random = input(); random.common.seed = '-1'; expect(() => createBenchmarkPlan(random)).toThrow('non-random');
  const oversized = input(); oversized.targets = Array.from({ length: 34 }, (_, i) => targetFixture({ id: String(i) })); expect(() => createBenchmarkPlan(oversized)).toThrow('100');
  const broken = input(); broken.targets[0]!.models = undefined; expect(() => createBenchmarkPlan(broken)).toThrow('Incomplete');
});

it('captures explicit order and all request defaults without reading weights', () => {
  const plan = planFixture({ mode: 'cold-warm', repeats: 3 });
  expect(plan.models.map(model => model.target.id)).toEqual(['a', 'b']); expect(plan.models[0]!.request.debug).toBe('on');
  const options = input(); options.targets.push(targetFixture({ id: 'b' })); options.protocol.order = 'reverse';
  expect(createBenchmarkPlan(options).models.map(model => model.target.id)).toEqual(['b', 'a']);
});

it('keeps explicit common model arguments, while a sparse override can clear them', () => {
  const target = targetFixture({ id: 'qwen' }); target.facts = { family: 'qwen-image-2.1', variant: 'unknown', evidence: [] };
  const common = { ...parametersFixture(), modelArguments: 'qwen_image_2_1_prefix_cache=true' };
  expect(benchmarkParameters({ common, target, strategy: 'model-defaults', overrides: {} }).parameters.modelArguments).toBe(common.modelArguments);
  expect(benchmarkParameters({ common, target, strategy: 'model-defaults', overrides: { modelArguments: '' } }).parameters.modelArguments).toBe('');
});

it('snapshots BF16 conversion independently for shared and overridden models', () => {
  const override: Partial<ReturnType<typeof parametersFixture>> = { bf16WeightType: 'f32' };
  const options = { ...input(), overrides: { b: override } }; options.targets.push(targetFixture({ id: 'b' }));
  options.common.bf16WeightType = 'f16';
  const plan = createBenchmarkPlan(options);
  options.common.bf16WeightType = 'f32'; override.bf16WeightType = 'f16';
  expect(plan.models.map(model => model.request.parameters.bf16WeightType)).toEqual(['f16', 'f32']);
  expect(plan.models[1]!.overrides).toEqual({ bf16WeightType: 'f32' });
});

it('snapshots enabled LoRA requests per target without mutating disabled UI selections', () => {
  const file = new File(['adapter fixture'], 'style.safetensors');
  const selections: ImageLoraSelection[] = [{ file, strength: 0.75, enabled: true }, { file, strength: 1.5, enabled: false }];
  const options = { ...input(), targets: [targetFixture({ id: 'a' }), targetFixture({ id: 'b' })], loras: { a: selections } };
  const plan = createBenchmarkPlan(options);
  selections[0]!.strength = 2; selections[0]!.file = new File(['replacement'], 'other.gguf'); selections.pop();
  expect(plan.models[0]!.request.loras).toEqual([{ file, strength: 0.75 }]);
  expect(plan.models[0]!.request.loras[0]!.file).toBe(file);
  expect(plan.models[1]!.request.loras).toEqual([]);
});

it('does not validate a disabled adapter when capturing a diagnostics plan', () => {
  const disabled: ImageLoraSelection = { file: new File([], 'unavailable.gguf'), strength: NaN, enabled: false };
  const plan = createBenchmarkPlan({ ...input(), loras: { a: [disabled] } });
  expect(plan.models[0]!.request.loras).toEqual([]);
  expect(disabled).toMatchObject({ enabled: false, strength: NaN });
});

it('rejects invalid active LoRA strengths before creating any benchmark worker', () => {
  const file = new File(['adapter fixture'], 'style.gguf');
  expect(() => createBenchmarkPlan({ ...input(), loras: { a: [{ file, strength: NaN, enabled: true }] } })).toThrow();
});

it('snapshots input files, strength and reference order per target without broadcasting them', () => {
  const file = new File(['initial image'], 'initial.png', { type: 'image/png' });
  const reference = new File(['reference image'], 'reference.png', { type: 'image/png' });
  const inputs = { initImage: file, strength: 0.4, referenceImages: [reference] };
  const plan = createBenchmarkPlan({ ...input(), targets: [targetFixture({ id: 'a' }), targetFixture({ id: 'b' })], imageInputs: { a: inputs } });
  inputs.referenceImages.length = 0; inputs.strength = 0.9;
  expect(plan.models[0]!.request.imageInputs).toEqual({ initImage: file, strength: 0.4, referenceImages: [reference] });
  expect(plan.models[1]!.request.imageInputs).toEqual({ strength: 0.75, referenceImages: [] });
});
