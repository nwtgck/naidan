import { Secret } from '@/utils/secret';
import { it, expect } from 'vitest';
import type { WorkflowStep, WorkflowDefinition } from '@/01-models/workflow';
import { toVolumeId, toToolCallId } from '@/01-models/ids';
import { formatWorkflowDefinition, parseWorkflowDefinition } from '@/00-storage/service/workflow-json';
import { baseStep, stepId, reference } from './workflow.test-support';
import { shareWorkflowStructure } from './sharing';
import { flatWorkflowSteps } from './editor';

it('removes all authored content, connections, field names and capability bindings', () => {
  const kinds: WorkflowStep['type'][] = ['value', 'model_selection', 'text_generation', 'audio_generation', 'image_generation', 'tool_call', 'request_input', 'read_file', 'write_file', 'repeat', 'for_each', 'if', 'parse_json'];
  const source: WorkflowDefinition = { name: 'secret-title', steps: kinds.map(type => baseStep({ type, id: `secret-${type}` })) };
  for (const step of source.steps) {
    switch (step.type) {
    case 'value': step.value = { type: 'json_compose', base: { 'secret-field': 'secret-base', pin: 707070 }, assignments: [{ path: ['secret-field'], value: { type: 'literal', value: 'secret-assigned' } }] };
      break;
    case 'text_generation':
      step.target = { type: 'model', endpoint: { type: 'openai', url: 'https://secret-url/?secret-query', httpHeaders: [['secret-header', Secret.from({ value: 'secret-token' })]] }, modelId: 'secret-model' };
      step.systemPrompt = { behavior: 'append', content: 'secret-system' };
      step.lmParameters = { temperature: 707070, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: ['secret-stop'], reasoning: { effort: undefined } };
      step.appendMessages = [{ role: 'assistant', parts: [{ type: 'reasoning', text: 'secret-thought' }, { type: 'tool_call', id: toToolCallId({ raw: 'secret-call' }), name: 'secret-tool', arguments: 'secret-arguments' }] }, { role: 'tool', parts: [{ type: 'tool_result', id: toToolCallId({ raw: 'secret-call' }), status: 'success', code: undefined, content: { type: 'literal', value: 'secret-result' } }] }];
      step.toolExecution = { maxRounds: 8, maxCalls: 32, shell: { volumeId: toVolumeId({ raw: 'secret-folder' }), access: 'read-write' } };
      break;
    case 'image_generation': Object.assign(step.parameters, { unknownSecret: { type: 'literal', value: 'secret-unknown' } });
      step.parameters.seed = { type: 'literal', value: 'secret-seed' };
      break;
    case 'audio_generation': step.parameters.seed = { type: 'literal', value: 707070 };
      break;
    case 'read_file': case 'write_file': step.volumeId = toVolumeId({ raw: 'secret-folder' });
      step.relativePath = { type: 'literal', value: 'secret/path' };
      break;
    case 'repeat': case 'for_each': step.state = { 'secret-state': { initial: { type: 'literal', value: 'secret-state-value' }, next: { type: 'loop_state', stepId: step.id, key: 'secret-state' } } };
      break;
    case 'tool_call': step.tool = { name: 'shell_execute', volumeId: toVolumeId({ raw: 'secret-volume' }), access: 'read-write' };
      step.arguments = { type: 'literal', value: { shell_script: 'secret-script' } };
      break;
    case 'if': case 'request_input': case 'parse_json': case 'model_selection': break;
    default: {
      const exhaustive: never = step;
      throw new Error(String(exhaustive));
    }
    }
  }
  Object.assign(source, { secretExtra: 'secret-extra' });
  const before = JSON.stringify(source);
  const shared = shareWorkflowStructure({ definition: source });
  const text = formatWorkflowDefinition({ definition: shared });
  expect(text).not.toContain('secret');
  expect(text).not.toContain('Secret');
  expect(text).not.toContain('707070');
  expect(text).not.toContain('localhost');
  expect(text).not.toContain('httpHeaders');
  expect(JSON.stringify(source)).toBe(before);
  expect(parseWorkflowDefinition({ text })).toEqual(shared);
  expect(flatWorkflowSteps({ steps: shared.steps }).map(step => step.type)).toEqual(kinds);
});

it('rewires scoped state, branch output names, object keys and nested reference paths consistently', () => {
  const branch: Extract<WorkflowStep, { type: 'if' }> = {
    id: stepId({ raw: 'private-branch' }),
    name: 'private',
    type: 'if',
    condition: { type: 'literal', value: true },
    then: { steps: [], outputs: { 'private.key': { type: 'object', properties: { 'private.child': { type: 'literal', value: 'secret' } } } } },
    else: { steps: [], outputs: { 'private.key': { type: 'literal', value: null } } },
  };
  const source: WorkflowDefinition = {
    name: '',
    steps: [
      branch,
      { id: stepId({ raw: 'consumer' }), name: '', type: 'value', value: { type: 'get', value: reference({ id: 'private-branch', output: 'private.key' }), path: ['private.child'] } },
    ],
  };
  const shared = shareWorkflowStructure({ definition: source });
  const producer = shared.steps[0]!, consumer = shared.steps[1]!;
  if (producer.type !== 'if' || consumer.type !== 'value' || consumer.value.type !== 'get' || consumer.value.value.type !== 'step_output') {
    throw new Error('fixture');
  }
  expect(consumer.value.value.stepId).toBe(producer.id);
  expect(Object.keys(producer.then.outputs)).toEqual([consumer.value.value.output]);
  const nested = producer.then.outputs[consumer.value.value.output]!;
  if (nested.type !== 'object') {
    throw new Error('fixture');
  }
  expect(Object.keys(nested.properties)).toEqual(consumer.value.path);
});

export const TEST_ONLY = {
};
