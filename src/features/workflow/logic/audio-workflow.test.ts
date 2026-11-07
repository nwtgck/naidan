import { describe, it, expect, vi } from 'vitest';
import { parseWorkflowDefinition, formatWorkflowDefinition, applyWorkflowStepJson } from '@/00-storage/service/workflow-json';
import type { WorkflowDefinition, WorkflowStep } from '@/01-models/workflow';
import { validateWorkflow, copyWorkflowSteps, workflowOutputNames } from './definition';
import { analyzeWorkflowTypes } from './value-types';
import { workflowReferenceChoices } from './value-inputs';
import { audioStep, audioResult } from './audio-generation.test-support';
import { runtimeFixture, literal, reference, valueStep, baseStep } from './workflow.test-support';
import { generateWorkflowAudio } from './audio-generation';
import type { WorkflowRuntimeServices } from './runtime';
import { defaultAudioParameters } from '@/features/audio-generation/types';
import { workflowAudioParameterKeys } from './audio-input';
import { createWorkflowTestFileSystem } from '@/00-storage/service/workflow-files.test-support';
import { exportWorkflowResults } from './files';

const generateAudio = (): WorkflowRuntimeServices['generateAudio'] => async ({ input }) => generateWorkflowAudio({
  input,
  generate: async () => audioResult({ samples: 4, finishReason: 'stop' }),
  normalizeReference: async ({ source }) => ({ wav: source, samples: 4, trimmed: false }),
});

describe('Workflow audio definition and execution', () => {
  it('round trips audio definitions without runtime options or implicit authority', () => {
    const definition = { name: 'Speak', steps: [audioStep({ id: 'voice' })] };
    const text = formatWorkflowDefinition({ definition });
    expect(parseWorkflowDefinition({ text })).toEqual(definition);
    const json = JSON.parse(text);
    json.steps[0].trusted = true;
    expect(() => parseWorkflowDefinition({ text: JSON.stringify(json) })).toThrow();
    delete json.steps[0].trusted;
    json.steps[0].options = {};
    expect(() => parseWorkflowDefinition({ text: JSON.stringify(json) })).toThrow();
  });

  it('replaces discriminated audio expressions in partial JSON without stale fields', () => {
    const step = audioStep({ id: 'voice' });
    step.modelId = { type: 'get', value: literal({ value: '{}' }), path: ['modelId'] };
    step.parameters.seed = { type: 'get', value: literal({ value: '{}' }), path: ['seed'] };
    step.reference = { type: 'get', value: literal({ value: '{}' }), path: ['audio'] };
    const edited = applyWorkflowStepJson({ step, text: JSON.stringify({ modelId: literal({ value: 'other.gguf' }), parameters: { seed: literal({ value: 3 }) }, reference: reference({ id: 'file', output: 'content' }) }) });
    expect(edited.type).toBe('audio_generation');
    if (edited.type !== 'audio_generation') {
      throw new Error('Expected audio');
    }
    expect(edited.modelId).toEqual(literal({ value: 'other.gguf' }));
    expect(edited.parameters.seed).toEqual(literal({ value: 3 }));
    expect(edited.parameters.temperature).toEqual(step.parameters.temperature);
    expect(edited.reference).toEqual(reference({ id: 'file', output: 'content' }));
    expect(edited.id).toBe(step.id);
  });

  it('reconnects every audio input when copying reusable steps', () => {
    const source = valueStep({ id: 'source', value: literal({ value: 'source' }) });
    const step = audioStep({ id: 'voice' });
    step.modelId = reference({ id: 'source', output: 'value' });
    step.text = reference({ id: 'source', output: 'value' });
    step.reference = reference({ id: 'source', output: 'value' });
    for (const key of workflowAudioParameterKeys) {
      step.parameters[key] = reference({ id: 'source', output: 'value' });
    }
    const copy = copyWorkflowSteps({ steps: [source, step] });
    const audio = copy[1]!;
    if (audio.type !== 'audio_generation') {
      throw new Error('Expected audio');
    }
    const expected = { type: 'step_output', stepId: copy[0]!.id, output: 'value' };
    for (const value of [audio.modelId, audio.text, audio.reference, ...Object.values(audio.parameters)]) {
      expect(value).toEqual(expected);
    }
    expect(copy[0]!.id).not.toBe(source.id);
    expect(copy[1]!.id).not.toBe(step.id);
  });

  it('offers binary audio and completion outputs through typed references', () => {
    const step = audioStep({ id: 'voice' });
    const next = valueStep({ id: 'next', value: reference({ id: 'voice', output: 'complete' }) });
    const definition = { name: '', steps: [step, next] };
    expect(validateWorkflow({ definition })).toEqual([]);
    expect(workflowOutputNames({ step })).toEqual(['audio', 'metadata', 'complete']);
    const scope = analyzeWorkflowTypes({ definition }).inputs.get(next.id)!;
    const choices = workflowReferenceChoices({ scope, expected: 'binary' });
    expect(choices.some(choice => choice.value.type === 'step_output' && choice.value.stepId === step.id && choice.value.output === 'audio')).toBe(true);
    expect(choices.some(choice => choice.value.type === 'step_output' && choice.value.output === 'complete')).toBe(false);
  });

  it.each([
    ['language', 'unsupported'], ['audioBackend', 'remote'], ['contextTokens', 1023], ['maxFrames', 0], ['temperature', 3], ['topK', 0], ['topP', 0], ['seed', -1],
  ] as const)('validates a known %s literal before execution', (key, value) => {
    const step = audioStep({ id: 'voice' });
    step.parameters[key] = literal({ value });
    expect(validateWorkflow({ definition: { name: '', steps: [step] } }).some(issue => issue.path === `parameters.${key}`)).toBe(true);
  });

  it('rejects binary-to-text and text-to-reference implicit conversions', () => {
    const step = audioStep({ id: 'voice' });
    step.reference = literal({ value: 'https://example.invalid/voice.wav' });
    expect(validateWorkflow({ definition: { name: '', steps: [step] } }).some(issue => issue.path === 'reference')).toBe(true);
    const second = { ...audioStep({ id: 'second' }), text: reference({ id: 'voice', output: 'audio' }) };
    step.reference = undefined;
    expect(validateWorkflow({ definition: { name: '', steps: [step, second] } }).some(issue => issue.stepId === second.id && issue.path === 'text')).toBe(true);
  });

  it('resolves parameter expressions without conversion and leaves model evidence independent of text', async () => {
    const generated = baseStep({ type: 'text_generation', id: 'write' });
    const step = audioStep({ id: 'voice' });
    step.text = reference({ id: 'write', output: 'text' });
    step.parameters.seed = { type: 'arithmetic', operator: 'add', left: literal({ value: 2 }), right: literal({ value: 3 }) };
    const generate = vi.fn(generateAudio());
    await using run = await runtimeFixture({ definition: { name: '', steps: [generated, step] }, overrides: { generateAudio: generate } });
    expect(run.result.status).toBe('completed');
    expect(generate.mock.calls[0]![0].input.request).toEqual({ ...defaultAudioParameters(), modelId: 'voice.gguf', text: 'generated', seed: 5 });
    expect(generate.mock.calls[0]![0].input.targetSources).toEqual(['definition']);
  });

  it('preserves generated model-name evidence through JSON parsing and projection', async () => {
    const generated = baseStep({ type: 'text_generation', id: 'write' });
    const parse: WorkflowStep = { ...baseStep({ type: 'parse_json', id: 'parse' }), type: 'parse_json', source: reference({ id: 'write', output: 'text' }) };
    const step = audioStep({ id: 'voice' });
    step.modelId = { type: 'get', value: reference({ id: 'parse', output: 'value' }), path: ['model'] };
    const generate = vi.fn(generateAudio());
    await using run = await runtimeFixture({
      definition: { name: '', steps: [generated, parse, step] },
      overrides: {
        generate: async () => ({ text: { type: 'json', value: '{"model":"voice.gguf"}' } }),
        generateAudio: generate,
      },
    });
    expect(run.result.status).toBe('completed');
    expect(generate.mock.calls[0]![0].input.targetSources).toContain('model_output');
  });

  it('validates dynamically invalid parameters before the audio effect boundary', async () => {
    const input: WorkflowStep = { ...baseStep({ type: 'request_input', id: 'input' }), type: 'request_input', prompt: literal({ value: 'Frames' }), responseType: 'json' };
    const step = audioStep({ id: 'voice' });
    step.parameters.maxFrames = reference({ id: 'input', output: 'value' });
    const generate = vi.fn(generateAudio());
    await using run = await runtimeFixture({ definition: { name: '', steps: [input, step] }, overrides: { requestInput: async () => '0', generateAudio: generate } });
    expect(run.result.status).toBe('failed');
    expect(generate).not.toHaveBeenCalled();
    expect(run.store.getUsage().entries).toBe(0);
  });

  it('rejects an oversized dynamic text before engine loading', async () => {
    const text = valueStep({ id: 'text', value: literal({ value: 'a'.repeat(8193) }) });
    const step = { ...audioStep({ id: 'voice' }), text: reference({ id: 'text', output: 'value' }) };
    const generate = vi.fn(generateAudio());
    await using run = await runtimeFixture({ definition: { name: '', steps: [text, step] }, overrides: { generateAudio: generate } });
    expect(run.result.status).toBe('failed');
    expect(generate).not.toHaveBeenCalled();
  });

  it('retains generated audio as a reference for a later step and exports WAV bytes', async () => {
    const first = audioStep({ id: 'first' });
    const second = { ...audioStep({ id: 'second' }), reference: reference({ id: 'first', output: 'audio' }) };
    const generate = vi.fn(generateAudio());
    await using run = await runtimeFixture({ definition: { name: '', steps: [first, second] }, overrides: { generateAudio: generate } });
    expect(run.result.status).toBe('completed');
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]![0].input.reference?.output.byteLength).toBe(52);
    using files = createWorkflowTestFileSystem();
    await exportWorkflowResults({ result: run.result, directory: files.root, signal: new AbortController().signal, writtenFiles: [] });
    const wav = [...files.files.entries()].filter(([path]) => path.endsWith('.wav'));
    expect(wav).toHaveLength(2);
    expect(wav[0]![1]).toEqual(audioResult({ samples: 4, finishReason: 'stop' }).wav);
    expect(files.text({ path: 'index.json' })).toContain('.wav');
  });

  it('runs audio sequentially inside a loop and carries completion into its stop condition', async () => {
    const step = audioStep({ id: 'voice' });
    const loop: WorkflowStep = { ...baseStep({ type: 'repeat', id: 'loop' }), type: 'repeat', count: literal({ value: 3 }), state: {}, body: { steps: [step] }, emit: reference({ id: 'voice', output: 'metadata' }), stopWhen: reference({ id: 'voice', output: 'complete' }) };
    const generate = vi.fn(generateAudio());
    const definition: WorkflowDefinition = { name: '', steps: [loop] };
    await using run = await runtimeFixture({ definition, overrides: { generateAudio: generate } });
    expect(run.result.status).toBe('completed');
    expect(generate).toHaveBeenCalledOnce();
    expect(run.result.outputs.get(loop.id)?.iterations).toEqual({ type: 'json', value: 1 });
    expect(run.result.outputs.get(loop.id)?.stoppedBy).toEqual({ type: 'json', value: 'condition' });
    // The loop does not keep the un-emitted audio binary alive.
    expect(run.store.getUsage().entries).toBe(1);
  });
});
