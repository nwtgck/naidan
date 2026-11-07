import { it, expect } from 'vitest';
import { imageStep, imageRequest } from './image-generation.test-support';
import { workflowImageLiteralIssues, resolveWorkflowImageRequest, workflowImageParameterKeys } from './image-input';
import { literal, reference, valueStep, runtimeFixture, baseStep, stepId } from './workflow.test-support';
import { validateWorkflow, copyWorkflowSteps } from './definition';
import { formatWorkflowDefinition, parseWorkflowDefinition, applyWorkflowStepJson } from '@/00-storage/service/workflow-json';
import { analyzeWorkflowTypes } from './value-types';
import type { RuntimeValue } from './values';

it('round-trips image inputs without changing large integer seeds or adding a format version', () => {
  const step = imageStep({ id: 'image' });
  step.parameters.seed = literal({ value: '9223372036854775807' });
  step.gpuBudgetMiB = literal({ value: 2048 });
  const definition = { name: 'Images', steps: [step] };
  expect(parseWorkflowDefinition({ text: formatWorkflowDefinition({ definition }) })).toEqual(definition);
  expect(validateWorkflow({ definition })).toEqual([]);
});

it.each([
  ['width', 127], ['height', 257], ['steps', 0], ['guidance', -1], ['seed', '9223372036854775808'],
  ['seed', 42], ['vaeTiling', 'true'], ['sampler', 'invented'], ['profile', 'remote-url'], ['weightResidency', 'guessed'],
] as const)('validates the literal image parameter %s = %s', (key, value) => {
  const step = imageStep({ id: 'image' });
  step.parameters[key] = literal({ value });
  expect(workflowImageLiteralIssues({ step }).some(issue => issue.path === `parameters.${key}`)).toBe(true);
});

it('validates runtime inputs after dynamic evaluation instead of trusting their static unknown type', async () => {
  const request = imageRequest();
  const values: Record<string, RuntimeValue> = Object.fromEntries(Object.entries(request.parameters).map(([key, value]) => [key, { type: 'json', value }]));
  values.model = { type: 'json', value: request.model };
  values.prompt = { type: 'json', value: 'A tree' };
  expect(await resolveWorkflowImageRequest({ values, signal: new AbortController().signal })).toEqual(request);
  values.width = { type: 'json', value: '256' };
  await expect(resolveWorkflowImageRequest({ values, signal: new AbortController().signal })).rejects.toThrow('number');
  values.width = { type: 'json', value: 256 };
  values.model = { type: 'json', value: { primary: { slot: 'model' } } };
  await expect(resolveWorkflowImageRequest({ values, signal: new AbortController().signal })).rejects.toThrow();
});

it('rewires model, prompt, optional budget and every image parameter when cloning a part', () => {
  const source = valueStep({ id: 'source', value: literal({ value: 1 }) });
  const image = imageStep({ id: 'image' });
  const ref = reference({ id: 'source', output: 'value' });
  image.model = image.prompt = image.gpuBudgetMiB = ref;
  for (const key of workflowImageParameterKeys) {
    image.parameters[key] = ref;
  }
  const copies = copyWorkflowSteps({ steps: [source, image] });
  const clone = copies[1];
  if (clone?.type !== 'image_generation') {
    throw new Error('Missing cloned image');
  }
  const expected = { ...ref, stepId: copies[0]!.id };
  expect([clone.model, clone.prompt, clone.gpuBudgetMiB, ...Object.values(clone.parameters)]).toEqual(Array.from({ length: workflowImageParameterKeys.length + 3 }, () => expected));
  expect(copies[0]!.id).not.toBe(source.id);
});

it('replaces partial JSON expression tags without leaving obsolete literal data', () => {
  const step = imageStep({ id: 'image' });
  const changed = applyWorkflowStepJson({ step, text: '{"parameters":{"seed":{"type":"step_output","stepId":"source","output":"value"}},"prompt":{"type":"step_output","stepId":"source","output":"value"}}' });
  expect(changed.type).toBe('image_generation');
  if (changed.type !== 'image_generation') {
    throw new Error('Expected image');
  }
  expect(changed.parameters.seed).toEqual(reference({ id: 'source', output: 'value' }));
  expect(changed.prompt).toEqual(reference({ id: 'source', output: 'value' }));
  expect(changed.parameters.width).toEqual(step.parameters.width);
});

it('publishes a binary image type and structured metadata without a fake complete flag', () => {
  const image = imageStep({ id: 'image' });
  const analysis = analyzeWorkflowTypes({ definition: { name: '', steps: [image] } });
  expect(analysis.problems).toEqual([]);
  // Downstream validation must reject using the image as ordinary text.
  const following = imageStep({ id: 'next' });
  following.prompt = reference({ id: 'image', output: 'image' });
  expect(validateWorkflow({ definition: { name: '', steps: [image, following] } }).some(issue => issue.path === 'prompt')).toBe(true);
});

it('preserves interactive origin through JSON parsing and projection into image selection', async () => {
  const image = imageStep({ id: 'image' });
  const received: string[][] = [];
  image.model = reference({ id: 'model-json', output: 'value' });
  await using test = await runtimeFixture({
    definition: {
      name: '',
      steps: [
        { id: valueStep({ id: 'question', value: literal({ value: '' }) }).id, name: 'Question', type: 'request_input', prompt: literal({ value: 'Choose' }), responseType: 'json' },
        valueStep({ id: 'model-json', value: { type: 'get', value: reference({ id: 'question', output: 'value' }), path: ['model'] } }),
        image,
      ],
    },
    overrides: {
      requestInput: async () => JSON.stringify({ model: imageRequest().model }),
      generateImage: async ({ input }) => {
        received.push([...input.targetSources]);
        return { metadata: { type: 'json', value: {} } };
      },
    },
  });
  expect(test.result.status).toBe('completed');
  expect(received).toEqual([['interactive_input']]);
});

it('keeps model-generated selection authority dynamic after parsing and field projection', async () => {
  const image = imageStep({ id: 'image' });
  image.model = { type: 'get', value: reference({ id: 'parsed', output: 'value' }), path: ['model'] };
  const received: string[][] = [];
  await using test = await runtimeFixture({
    definition: { name: '', steps: [baseStep({ type: 'text_generation', id: 'chooser' }), { type: 'parse_json', id: stepId({ raw: 'parsed' }), name: 'Parse', source: reference({ id: 'chooser', output: 'text' }) }, image] },
    overrides: {
      generate: async () => ({ text: { type: 'json', value: JSON.stringify({ model: imageRequest().model }) } }),
      generateImage: async ({ input }) => {
        received.push([...input.targetSources]);
        return { metadata: { type: 'json', value: {} } };
      },
    },
  });
  expect(test.result.error).toBeUndefined();
  expect(test.result.status).toBe('completed');
  expect(received).toEqual([['model_output']]);
});

it('does not turn a fixed model into a dynamic connection merely because its prompt or seed is generated', async () => {
  const image = imageStep({ id: 'image' });
  image.prompt = reference({ id: 'writer', output: 'text' });
  image.parameters.seed = reference({ id: 'seed', output: 'text' });
  const received: string[][] = [];
  await using test = await runtimeFixture({
    definition: { name: '', steps: [baseStep({ type: 'text_generation', id: 'writer' }), baseStep({ type: 'text_generation', id: 'seed' }), image] },
    overrides: {
      generate: async ({ input }) => ({ text: { type: 'json', value: input.step.id === stepId({ raw: 'writer' }) ? 'A generated tree' : '7' } }),
      generateImage: async ({ input }) => {
        received.push([...input.targetSources]);
        return { metadata: { type: 'json', value: {} } };
      },
    },
  });
  expect(test.result.error).toBeUndefined();
  expect(test.result.status).toBe('completed');
  expect(received).toEqual([['definition']]);
});

export const TEST_ONLY = {
};
