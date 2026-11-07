import { Secret } from '@/utils/secret';
import { clonePlainData } from '@/utils/clone-plain-data';
import type { WorkflowDefinition, WorkflowStep, WorkflowValue } from '@/01-models/workflow';
import { formatWorkflowDefinition, parseWorkflowDefinition } from '@/00-storage/service/workflow-json';
import { describe, expect, it } from 'vitest';
import { copyWorkflowSteps } from './definition';
import { createWorkflowHistory, moveWorkflowStep, replaceWorkflowStep } from './editor';
import { editWorkflowGraph } from './graph';
import { baseStep, runtimeFixture, valueStep } from './workflow.test-support';

function selection({ value }: { value: Secret<string> }): Extract<WorkflowStep, { type: 'model_selection' }> {
  const step = baseStep({ type: 'model_selection', id: 'connection' });
  if (step.type !== 'model_selection') {
    throw new Error('Invalid test fixture.');
  }
  step.targets = [{ endpoint: { type: 'openai', url: 'https://model.example/v1', httpHeaders: [['Authorization', value]] }, modelId: 'model', lmParameters: undefined }];
  return step;
}

function header({ step }: { step: WorkflowStep }): Secret<string> {
  if (step.type !== 'model_selection' || step.targets[0]?.endpoint.type !== 'openai') {
    throw new Error('Expected model selection.');
  }
  return step.targets[0].endpoint.httpHeaders![0]![1];
}

describe('Workflow credential boundaries', () => {
  it('preserves Secret during copying, reordering, replacement and undo', () => {
    const secret = Secret.from({ value: 'credential-for-editor' });
    const source: WorkflowDefinition = { name: 'workflow', steps: [selection({ value: secret }), valueStep({ id: 'after', value: { type: 'literal', value: 1 } })] };
    const copied = copyWorkflowSteps({ steps: source.steps });
    expect(header({ step: copied[0]! })).toBe(secret);
    const moved = moveWorkflowStep({ definition: source, id: source.steps[0]!.id, target: { parentId: undefined, branch: 'root', index: 2 } });
    expect(header({ step: moved.steps[1]! })).toBe(secret);
    const replaced = replaceWorkflowStep({ definition: moved, step: selection({ value: secret }) });
    expect(header({ step: replaced.steps[1]! })).toBe(secret);
    const history = createWorkflowHistory();
    history.push({ definition: source });
    const restored = history.undo({ current: replaced });
    expect(restored && header({ step: restored.steps[0]! })).toBe(secret);
    expect(header({ step: source.steps[0]! })).toBe(secret);
  });

  it('round-trips authenticated endpoints through deliberate Workflow JSON without serializing domain secrets', () => {
    const secret = Secret.from({ value: 'credential-for-backup' });
    const source: WorkflowDefinition = { name: 'workflow', steps: [selection({ value: secret })] };
    expect(JSON.stringify(source)).not.toContain(secret.reveal());
    expect(JSON.stringify(source)).toContain('[masked]');
    const exported = formatWorkflowDefinition({ definition: source });
    expect(exported).toContain(secret.reveal());
    const restored = parseWorkflowDefinition({ text: exported });
    expect(header({ step: restored.steps[0]! }).reveal()).toBe(secret.reveal());
  });

  it('rejects graph edits based on a header-only stale model expression', () => {
    const step = baseStep({ type: 'text_generation', id: 'generate' });
    if (step.type !== 'text_generation') {
      throw new Error('Invalid test fixture.');
    }
    const previous: WorkflowValue = {
      type: 'model',
      endpoint: { type: 'openai', url: 'https://model.example/v1', httpHeaders: [['Authorization', Secret.from({ value: 'before' })]] },
      modelId: 'model',
    };
    step.target = clonePlainData({ value: previous });
    const definition: WorkflowDefinition = { name: '', steps: [step] };
    step.target = { ...previous, endpoint: { type: 'openai', url: 'https://model.example/v1', httpHeaders: [['Authorization', Secret.from({ value: 'after' })]] } };
    expect(JSON.stringify(step.target)).toBe(JSON.stringify(previous));
    expect(() => editWorkflowGraph({
      definition,
      edit: { type: 'connect', stepId: step.id, location: ['target'], previous, reference: { type: 'literal', value: 'not a reference' } },
    })).toThrow('selected input changed');
  });

  it('preserves authenticated model targets in frozen execution snapshots', async () => {
    const secret = Secret.from({ value: 'credential-for-run' });
    const step = selection({ value: secret });
    await using run = await runtimeFixture({ definition: { name: '', steps: [step] }, overrides: {} });
    expect(run.result.status).toBe('completed');
    const output = run.result.outputs.get(step.id)?.value;
    const model = output?.type === 'array' ? output.items[0] : undefined;
    if (model?.type !== 'model' || model.endpoint.type !== 'openai') {
      throw new Error('Expected a model output.');
    }
    expect(model.endpoint.httpHeaders?.[0]?.[1].reveal()).toBe(secret.reveal());
  });
});
