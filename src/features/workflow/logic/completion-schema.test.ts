import { expect, it } from 'vitest';
import { toVolumeId, toToolCallId } from '@/01-models/ids';
import { parseWorkflowDefinition, formatWorkflowDefinition } from '@/00-storage/service/workflow-json';
import { copyWorkflowSteps } from './definition';
import { baseStep, reference, valueStep, literal } from './workflow.test-support';
import { imageStep } from './image-generation.test-support';

it('round-trips all completion fields without persisting runtime authority and rewires nested references on copy', () => {
  const source = valueStep({ id: 'source', value: literal({ value: 'data' }) });
  const ref = reference({ id: 'source', output: 'value' });
  const image = imageStep({ id: 'image' });
  image.imageInputs = { initImage: ref, referenceImages: [ref], strength: ref };
  image.preview = { enabled: true, mode: 'projection', interval: 2, startStep: 1, maxEdge: 0 };
  const input = baseStep({ id: 'input', type: 'request_input' });
  const generation = baseStep({ id: 'generation', type: 'text_generation' });
  if (input.type !== 'request_input' || generation.type !== 'text_generation') {
    throw new Error('fixture');
  }
  input.choices = ref;
  generation.toolConfigs = [{ key: 'builtin.wesh', status: 'enabled', naidanSysfs: { accessScope: 'none' } }];
  generation.toolExecution = { maxCalls: 12, maxRounds: 4, shell: { volumeId: toVolumeId({ raw: 'folder' }), access: 'read-only' } };
  generation.conversation = {
    type: 'conversation',
    messages: [
      { role: 'assistant', parts: [{ type: 'reasoning', text: 'private thought' }, { type: 'tool_call', id: toToolCallId({ raw: 'call' }), name: 'calculator', arguments: '{ "expression": "1 + 1" }' }] },
      { role: 'tool', parts: [{ type: 'tool_result', id: toToolCallId({ raw: 'call' }), status: 'success', code: undefined, content: ref }] },
    ],
  };
  const definition = { name: 'Complete format', steps: [source, image, input, generation] };
  const encoded = formatWorkflowDefinition({ definition });
  const decoded = parseWorkflowDefinition({ text: encoded });
  expect(decoded).toEqual(definition);
  expect(encoded).not.toContain('approved');
  const copied = copyWorkflowSteps({ steps: decoded.steps });
  const changed = { ...ref, stepId: copied[0]!.id };
  expect(copied[1]).toMatchObject({ imageInputs: { initImage: changed, referenceImages: [changed], strength: changed }, preview: image.preview });
  expect(copied[2]).toMatchObject({ choices: changed });
  expect(copied[3]).toMatchObject({
    toolExecution: generation.toolExecution,
    conversation: {
      messages: [
        generation.conversation.messages[0],
        { role: 'tool', parts: [{ type: 'tool_result', content: changed }] },
      ],
    },
  });
  expect(source.id).not.toBe(copied[0]!.id);
});

export const TEST_ONLY = {
};
