import { expect, it, vi } from 'vitest';
import { parseWorkflowDefinition, formatWorkflowDefinition } from '@/00-storage/service/workflow-json';
import { workflowChoicesSchema } from './input-choices';
import { baseStep, runtimeFixture, reference, valueStep } from './workflow.test-support';
import type { WorkflowDefinition } from '@/01-models/workflow';
import { readText } from './values';
import type { WorkflowRuntimeServices } from './runtime';

it.each([[], ['one'], Array(11).fill('x'), ['x', 'x'], [' x ', 'x'], [' ', 'x'], [`\
line
break`, 'x'], ['line\u2028break', 'x'], ['x'.repeat(201), 'y'], [1, 2]])('rejects invalid choices %j', choices => {
  expect(workflowChoicesSchema.safeParse(choices).success).toBe(false);
});

it('round-trips choices and only accepts an exact displayed response', async () => {
  const step = baseStep({ type: 'request_input', id: 'choice' });
  if (step.type !== 'request_input') {
    throw new Error('fixture');
  }
  step.choices = { type: 'literal', value: [' Yes ', 'No'] };
  const definition: WorkflowDefinition = { name: 'choose', steps: [step] };
  const restored = parseWorkflowDefinition({ text: formatWorkflowDefinition({ definition }) });
  const requestInput = vi.fn<WorkflowRuntimeServices['requestInput']>(async () => ' Yes ');
  await using good = await runtimeFixture({ definition: restored, overrides: { requestInput } });
  expect(good.result.status).toBe('completed');
  expect(requestInput.mock.calls[0]?.[0]).toMatchObject({ choices: [' Yes ', 'No'] });
  expect(await readText({ value: good.result.outputs.get(step.id)!.value!, maxBytes: 200, signal: good.controller.signal })).toBe(' Yes ');
  await using wrong = await runtimeFixture({ definition: restored, overrides: { requestInput: async () => 'Yes' } });
  expect(wrong.result.status).toBe('failed');
  expect(wrong.result.outputs.size).toBe(0);
});

it('rejects invalid evaluated choices before prompting the user', async () => {
  const step = baseStep({ type: 'request_input', id: 'choice' });
  if (step.type !== 'request_input') {
    throw new Error('fixture');
  }
  const source = valueStep({ id: 'source', value: { type: 'literal', value: ['a', 'a'] } });
  step.choices = reference({ id: 'source', output: 'value' });
  const requestInput = vi.fn();
  await using fixture = await runtimeFixture({ definition: { name: 'x', steps: [source, step] }, overrides: { requestInput } });
  expect(fixture.result.status).toBe('failed');
  expect(requestInput).not.toHaveBeenCalled();
});

export const TEST_ONLY = {
};
