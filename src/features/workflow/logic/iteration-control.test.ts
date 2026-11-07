import { describe, it, expect, vi } from 'vitest';
import type { WorkflowDefinition, WorkflowStep, WorkflowValue, WorkflowExecutionLimits } from '@/01-models/workflow';
import { parseWorkflowDefinition, formatWorkflowDefinition, applyWorkflowStepJson } from '@/00-storage/service/workflow-json';
import { runtimeFixture, baseStep, valueStep, literal, reference, stepId } from './workflow.test-support';
import { validateWorkflow, copyWorkflowSteps } from './definition';
import { analyzeWorkflowTypes } from './value-types';
import { DEFAULT_WORKFLOW_EXECUTION_LIMITS, WorkflowExecutionLimitError, workflowExecutionLimitIssues } from './execution-control';
import { calculateWorkflowNumber } from './operators';
import { materializeJson, readText, spoolText } from './values';
import { createOutputStoreFixture } from './output-store.test-support';
import { executeWorkflow, type WorkflowRuntimeServices } from './runtime';

function loop({ id, end }: { id: string, end: number | undefined }): Extract<WorkflowStep, { type: 'for_each' }> {
  return {
    id: stepId({ raw: id }),
    name: id,
    type: 'for_each',
    source: { type: 'range', start: literal({ value: 0 }), end: end === undefined ? undefined : literal({ value: end }), step: literal({ value: 1 }) },
    state: {},
    body: { steps: [] },
    emit: undefined,
  };
}

function limits({ overrides }: { overrides: Partial<WorkflowExecutionLimits> }): WorkflowExecutionLimits {
  return { ...DEFAULT_WORKFLOW_EXECUTION_LIMITS, ...overrides };
}

function services({ overrides }: { overrides: Partial<WorkflowRuntimeServices> }): WorkflowRuntimeServices {
  return {
    generate: vi.fn(async () => ({})),
    callTool: async () => {
      throw new Error('No tool adapter.');
    },
    generateImage: async () => {
      throw new Error('No image adapter.');
    },
    generateAudio: async () => {
      throw new Error('No audio adapter.');
    },
    requestInput: vi.fn(async () => ''),
    readFile: vi.fn(async () => ({})),
    writeFile: vi.fn(async () => ({})),
    onStep: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('Composable numeric and boolean values', () => {
  it('evaluates the numeric operations without a custom expression string', async () => {
    const operators = ['add', 'subtract', 'multiply', 'divide', 'remainder'] as const;
    const steps = operators.map(operator => valueStep({ id: operator, value: { type: 'arithmetic', operator, left: literal({ value: 7 }), right: literal({ value: 2 }) } }));
    await using run = await runtimeFixture({ definition: { name: '', steps }, overrides: {} });
    expect(run.result.status).toBe('completed');
    expect(steps.map(step => run.result.outputs.get(step.id)!.value)).toEqual([9, 5, 14, 3.5, 1].map(value => ({ type: 'json', value })));
  });

  it('compares numbers and combines predicates without truthiness coercion', async () => {
    const steps = (['less', 'less_or_equal', 'greater', 'greater_or_equal'] as const).map(operator => valueStep({ id: operator, value: { type: 'compare', operator, left: literal({ value: 2 }), right: literal({ value: 2 }) } }));
    const both = valueStep({ id: 'both', value: { type: 'all', items: [reference({ id: 'less_or_equal', output: 'value' }), { type: 'not', value: reference({ id: 'greater', output: 'value' }) }] } });
    await using run = await runtimeFixture({ definition: { name: '', steps: [...steps, both] }, overrides: {} });
    expect(run.result.status).toBe('completed');
    expect(steps.map(step => run.result.outputs.get(step.id)!.value)).toEqual([false, true, false, true].map(value => ({ type: 'json', value })));
    expect(run.result.outputs.get(both.id)!.value).toEqual({ type: 'json', value: true });
  });

  it('short circuits unused expressions and defines empty all/any', async () => {
    const division: WorkflowValue = { type: 'compare', operator: 'greater', left: { type: 'arithmetic', operator: 'divide', left: literal({ value: 1 }), right: literal({ value: 0 }) }, right: literal({ value: 0 }) };
    const steps = [
      valueStep({ id: 'all', value: { type: 'all', items: [literal({ value: false }), division] } }),
      valueStep({ id: 'any', value: { type: 'any', items: [literal({ value: true }), division] } }),
      valueStep({ id: 'empty-all', value: { type: 'all', items: [] } }),
      valueStep({ id: 'empty-any', value: { type: 'any', items: [] } }),
    ];
    await using run = await runtimeFixture({ definition: { name: '', steps }, overrides: {} });
    expect(run.result.status).toBe('completed');
    expect(steps.map(step => run.result.outputs.get(step.id)!.value)).toEqual([false, true, true, false].map(value => ({ type: 'json', value })));
  });

  it('rejects known wrong types in preflight and unknown wrong types at runtime', async () => {
    const bad = valueStep({ id: 'bad', value: { type: 'arithmetic', operator: 'add', left: literal({ value: '2' }), right: literal({ value: 1 }) } });
    expect(validateWorkflow({ definition: { name: '', steps: [bad] } }).some(issue => issue.path === 'value.left')).toBe(true);
    const parsed: WorkflowStep = { id: stepId({ raw: 'parsed' }), name: '', type: 'parse_json', source: literal({ value: '"2"' }) };
    if (bad.value.type !== 'arithmetic') {
      throw new Error('fixture');
    }
    bad.value.left = reference({ id: 'parsed', output: 'value' });
    await using run = await runtimeFixture({ definition: { name: '', steps: [parsed, bad] }, overrides: {} });
    expect(run.result.status).toBe('failed');
    expect(String(run.result.error)).toContain('without implicit conversion');
  });

  it.each(['all', 'any', 'not'] as const)('rejects runtime non-booleans in %s', async type => {
    const parsed: WorkflowStep = { id: stepId({ raw: 'parsed' }), name: '', type: 'parse_json', source: literal({ value: '1' }) };
    const input = reference({ id: 'parsed', output: 'value' });
    const bad = valueStep({ id: 'bad', value: type === 'not' ? { type, value: input } : { type, items: [input] } });
    await using run = await runtimeFixture({ definition: { name: '', steps: [parsed, bad] }, overrides: {} });
    expect(run.result.status).toBe('failed');
    expect(String(run.result.error)).toMatch(/boolean/);
  });

  it('rejects zero division, non-finite results and unsafe integer results', () => {
    for (const operator of ['divide', 'remainder'] as const) {
      expect(() => calculateWorkflowNumber({ operator, left: 1, right: -0 })).toThrow('zero');
    }
    expect(() => calculateWorkflowNumber({ operator: 'multiply', left: Number.MAX_VALUE, right: 2 })).toThrow('non-finite');
    expect(() => calculateWorkflowNumber({ operator: 'add', left: Number.MAX_SAFE_INTEGER, right: 1 })).toThrow('precision');
    expect(calculateWorkflowNumber({ operator: 'add', left: 0.25, right: 0.5 })).toBe(0.75);
  });
});

describe('Conditional iteration', () => {
  it('commits the stopping iteration, emits it once, and observes incoming state', async () => {
    const each = loop({ id: 'loop', end: undefined });
    const state: WorkflowValue = { type: 'loop_state', stepId: each.id, key: 'total' };
    const current: WorkflowValue = { type: 'loop_item', stepId: each.id };
    each.state = { total: { initial: literal({ value: 0 }), next: { type: 'arithmetic', operator: 'add', left: state, right: current } } };
    each.body.steps = [valueStep({ id: 'limit', value: { type: 'compare', operator: 'greater_or_equal', left: current, right: literal({ value: 3 }) } })];
    each.stopWhen = reference({ id: 'limit', output: 'value' });
    each.emit = { type: 'object', properties: { index: current, before: state } };
    await using run = await runtimeFixture({ definition: { name: '', steps: [each] }, overrides: {} });
    expect(run.result.status).toBe('completed');
    const outputs = run.result.outputs.get(each.id)!;
    expect(outputs.iterations).toEqual({ type: 'json', value: 4 });
    expect(outputs.stoppedBy).toEqual({ type: 'json', value: 'condition' });
    expect(await materializeJson({ value: outputs.state!, signal: undefined })).toEqual({ total: 6 });
    expect(await materializeJson({ value: outputs.items!, signal: undefined })).toEqual([{ index: 0, before: 0 }, { index: 1, before: 0 }, { index: 2, before: 1 }, { index: 3, before: 3 }]);
    expect(analyzeWorkflowTypes({ definition: { name: '', steps: [each] } }).problems).toEqual([]);
  });

  it('does not request a range element after a successful stop', async () => {
    const each = loop({ id: 'loop', end: undefined });
    each.source = { type: 'range', start: literal({ value: Number.MAX_SAFE_INTEGER }), end: undefined, step: literal({ value: 1 }) };
    each.stopWhen = literal({ value: true });
    await using run = await runtimeFixture({ definition: { name: '', steps: [each] }, overrides: {} });
    expect(run.result.status).toBe('completed');
    expect(run.result.outputs.get(each.id)!.iterations).toEqual({ type: 'json', value: 1 });
  });

  it('keeps inner and outer stopping conditions local', async () => {
    const outer = loop({ id: 'outer', end: 3 }), inner = loop({ id: 'inner', end: undefined });
    inner.stopWhen = literal({ value: true });
    outer.body.steps = [inner];
    outer.emit = reference({ id: 'inner', output: 'iterations' });
    await using run = await runtimeFixture({ definition: { name: '', steps: [outer] }, overrides: {} });
    expect(run.result.status).toBe('completed');
    const outputs = run.result.outputs.get(outer.id)!;
    expect(outputs.iterations).toEqual({ type: 'json', value: 3 });
    expect(outputs.stoppedBy).toEqual({ type: 'json', value: 'source_exhausted' });
    expect(await materializeJson({ value: outputs.items!, signal: undefined })).toEqual([1, 1, 1]);
  });

  it('does not evaluate stopWhen for an empty sequence', async () => {
    const each = loop({ id: 'loop', end: 0 });
    each.stopWhen = { type: 'compare', operator: 'less', left: { type: 'arithmetic', operator: 'divide', left: literal({ value: 1 }), right: literal({ value: 0 }) }, right: literal({ value: 0 }) };
    await using run = await runtimeFixture({ definition: { name: '', steps: [each] }, overrides: {} });
    expect(run.result.status).toBe('completed');
    expect(run.result.outputs.get(each.id)!.iterations).toEqual({ type: 'json', value: 0 });
  });

  it('supports stopWhen on a counted repeat without expanding its count', async () => {
    const repeat = baseStep({ type: 'repeat', id: 'repeat' });
    if (repeat.type !== 'repeat') {
      throw new Error('fixture');
    }
    repeat.count = literal({ value: Number.MAX_SAFE_INTEGER });
    repeat.stopWhen = literal({ value: true });
    await using run = await runtimeFixture({ definition: { name: '', steps: [repeat] }, overrides: {} });
    expect(run.result.status).toBe('completed');
    expect(run.result.outputs.get(repeat.id)!.iterations).toEqual({ type: 'json', value: 1 });
  });

  it('validates the condition against the loop body and rewires its references when copied', () => {
    const each = loop({ id: 'loop', end: 2 });
    each.body.steps = [valueStep({ id: 'decision', value: literal({ value: true }) })];
    each.stopWhen = { type: 'all', items: [reference({ id: 'decision', output: 'value' }), { type: 'compare', operator: 'greater', left: { type: 'loop_index', stepId: each.id }, right: literal({ value: 0 }) }] };
    const copied = copyWorkflowSteps({ steps: [each] })[0]!;
    expect(validateWorkflow({ definition: { name: '', steps: [copied] } })).toEqual([]);
    if (copied.type !== 'for_each') {
      throw new Error('fixture');
    }
    expect(copied.body.steps[0]!.name).toBe('decision');
    expect(copied.stopWhen).toEqual({
      type: 'all',
      items: [
        { type: 'step_output', stepId: copied.body.steps[0]!.id, output: 'value' },
        { type: 'compare', operator: 'greater', left: { type: 'loop_index', stepId: copied.id }, right: literal({ value: 0 }) },
      ],
    });
    expect(copied.body.steps[0]!.id).not.toBe(each.body.steps[0]!.id);
    const invalid = { ...each, stopWhen: literal({ value: 'true' }) };
    expect(validateWorkflow({ definition: { name: '', steps: [invalid] } }).some(issue => issue.path === 'stopWhen')).toBe(true);
  });

  it('round trips limits and nested operators and supports partial condition editing', () => {
    const each = loop({ id: 'loop', end: undefined });
    each.stopWhen = { type: 'not', value: { type: 'compare', operator: 'less', left: { type: 'loop_index', stepId: each.id }, right: literal({ value: 4 }) } };
    const definition: WorkflowDefinition = { name: 'Conditional', steps: [each], executionLimits: limits({ overrides: { maxLoopIterations: 20, timeoutMs: 10000 } }) };
    const parsed = parseWorkflowDefinition({ text: formatWorkflowDefinition({ definition }) });
    expect(parsed).toEqual(definition);
    const edited = applyWorkflowStepJson({ step: each, text: '{"stopWhen":{"type":"literal","value":true}}' });
    expect(edited).toMatchObject({ stopWhen: { type: 'literal', value: true } });
    expect(JSON.stringify(edited)).not.toContain('"less"');
  });
});

describe('Execution-wide resource budgets', () => {
  it('allows more than 1000 iterations when within the configured budget', async () => {
    const each = loop({ id: 'loop', end: 1100 });
    await using run = await runtimeFixture({ definition: { name: '', steps: [each], executionLimits: limits({ overrides: { maxLoopIterations: 1100 } }) }, overrides: {} });
    expect(run.result.status).toBe('completed');
    expect(run.result.outputs.get(each.id)!.iterations).toEqual({ type: 'json', value: 1100 });
    expect(run.store.getUsage().entries).toBe(0);
  });

  it('charges nested loops against the same budget and fails rather than silently truncating', async () => {
    const outer = loop({ id: 'outer', end: 2 }), inner = loop({ id: 'inner', end: 2 });
    outer.body.steps = [inner];
    await using run = await runtimeFixture({ definition: { name: '', steps: [outer], executionLimits: limits({ overrides: { maxLoopIterations: 5 } }) }, overrides: {} });
    expect(run.result.status).toBe('failed');
    expect(run.result.error).toBeInstanceOf(WorkflowExecutionLimitError);
    expect(String(run.result.error)).toContain('total loop iterations');
  });

  it('checks each budget before performing the next operation', async () => {
    const effect = baseStep({ type: 'request_input', id: 'input' });
    const requestInput = vi.fn(async () => 'reply');
    await using stopped = await runtimeFixture({ definition: { name: '', steps: [effect], executionLimits: limits({ overrides: { maxStepExecutions: 0 } }) }, overrides: { requestInput } });
    expect(stopped.result.status).toBe('failed');
    expect(requestInput).not.toHaveBeenCalled();
    const data = valueStep({ id: 'value', value: literal({ value: 3 }) });
    await using evaluated = await runtimeFixture({ definition: { name: '', steps: [data], executionLimits: limits({ overrides: { maxValueEvaluations: 0 } }) }, overrides: {} });
    expect(evaluated.result.status).toBe('failed');
    expect(evaluated.result.outputs.size).toBe(0);
  });

  it('ends an input wait on timeout and retains outputs completed before it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    using clock = {
      [Symbol.dispose]() {
        vi.useRealTimers();
      },
    };
    void clock;
    const entered = Promise.withResolvers<void>();
    const generated = baseStep({ type: 'text_generation', id: 'text' });
    const ask = baseStep({ type: 'request_input', id: 'input' });
    const requestInput = vi.fn<WorkflowRuntimeServices['requestInput']>(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      entered.resolve();
    }));
    const pending = runtimeFixture({ definition: { name: '', steps: [generated, ask], executionLimits: limits({ overrides: { timeoutMs: 100 } }) }, overrides: { requestInput } });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(100);
    await using run = await pending;
    expect(requestInput).toHaveBeenCalledTimes(1);
    expect(run.result.status).toBe('failed');
    expect(run.result.error).toBeInstanceOf(WorkflowExecutionLimitError);
    expect(await readText({ value: run.result.outputs.get(generated.id)!.text!, maxBytes: 100, signal: undefined })).toBe('generated');
  });

  it('yields a purely in-memory open loop so a user cancellation can run', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('User stop')), 0);
    using timerOwner = {
      [Symbol.dispose]() {
        clearTimeout(timer);
      },
    };
    void timerOwner;
    const each = loop({ id: 'loop', end: undefined });
    const result = await executeWorkflow({ definition: { name: '', steps: [each], executionLimits: limits({ overrides: { maxLoopIterations: 10000000, maxValueEvaluations: 10000000 } }) }, store: fixture.store, signal: controller.signal, services: services({ overrides: {} }) });
    await using owner = {
      async [Symbol.asyncDispose]() {
        await result.release();
      },
    };
    void owner;
    expect(result.status).toBe('cancelled');
    expect(String(result.error)).toContain('User stop');
  });

  it('does not start a side effect if cancellation arrives during onStep', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const controller = new AbortController();
    const generate = vi.fn(async () => ({}));
    const result = await executeWorkflow({
      definition: { name: '', steps: [baseStep({ type: 'text_generation', id: 'text' })] },
      store: fixture.store,
      signal: controller.signal,
      services: services({
        overrides: {
          generate,
          onStep: async () => {
            controller.abort();
          },
        },
      }),
    });
    await using owner = {
      async [Symbol.asyncDispose]() {
        await result.release();
      },
    };
    void owner;
    expect(generate).not.toHaveBeenCalled();
    expect(result.status).toBe('cancelled');
  });

  it('counts expressions rather than also charging the step wrapper', async () => {
    await using run = await runtimeFixture({ definition: { name: '', steps: [valueStep({ id: 'one', value: literal({ value: 1 }) })], executionLimits: limits({ overrides: { maxValueEvaluations: 1, maxStepExecutions: 1 } }) }, overrides: {} });
    expect(run.result.status).toBe('completed');
  });

  it('reports an already cancelled empty workflow without emitting step events', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const controller = new AbortController();
    controller.abort(new Error('Already stopped'));
    const onStep = vi.fn(async () => undefined);
    const result = await executeWorkflow({ definition: { name: '', steps: [] }, store: fixture.store, signal: controller.signal, services: services({ overrides: { onStep } }) });
    await using owner = {
      async [Symbol.asyncDispose]() {
        await result.release();
      },
    };
    void owner;
    expect(result.status).toBe('cancelled');
    expect(onStep).not.toHaveBeenCalled();
  });

  it('does not mark a run completed when stopped during its last completed notification', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const controller = new AbortController();
    const result = await executeWorkflow({
      definition: { name: '', steps: [valueStep({ id: 'one', value: literal({ value: 1 }) })] },
      store: fixture.store,
      signal: controller.signal,
      services: services({
        overrides: {
          onStep: async ({ phase }) => {
            if (phase === 'completed') {
              controller.abort();
            }
          },
        },
      }),
    });
    await using owner = {
      async [Symbol.asyncDispose]() {
        await result.release();
      },
    };
    void owner;
    expect(result.status).toBe('cancelled');
    expect(result.outputs.get(stepId({ raw: 'one' }))!.value).toEqual({ type: 'json', value: 1 });
  });

  it('releases a provider output returned after the run was stopped', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const controller = new AbortController();
    const onStep = vi.fn(async () => undefined);
    const result = await executeWorkflow({
      definition: { name: '', steps: [baseStep({ type: 'text_generation', id: 'model' })] },
      store: fixture.store,
      signal: controller.signal,
      services: services({
        overrides: {
          onStep,
          generate: async ({ input }) => {
            const text = await spoolText({
              store: input.store,
              signal: input.signal,
              chunks: (async function* () {
                yield 'late';
              })(),
            });
            controller.abort();
            return { text };
          },
        },
      }),
    });
    await using owner = {
      async [Symbol.asyncDispose]() {
        await result.release();
      },
    };
    void owner;
    expect(result.status).toBe('cancelled');
    expect(result.outputs.size).toBe(0);
    expect(onStep).toHaveBeenCalledTimes(1);
    expect(fixture.store.getUsage().entries).toBe(0);
  });

  it('accepts a normal condition exit exactly at the iteration budget', async () => {
    const each = loop({ id: 'loop', end: undefined });
    each.stopWhen = { type: 'compare', operator: 'greater_or_equal', left: { type: 'loop_index', stepId: each.id }, right: literal({ value: 2 }) };
    await using run = await runtimeFixture({ definition: { name: '', steps: [each], executionLimits: limits({ overrides: { maxLoopIterations: 3 } }) }, overrides: {} });
    expect(run.result.status).toBe('completed');
    expect(run.result.outputs.get(each.id)!.stoppedBy).toEqual({ type: 'json', value: 'condition' });
  });

  it('rejects a dynamic non-boolean exit without committing or exposing partial loop output', async () => {
    const each = loop({ id: 'loop', end: 2 });
    const parsed: WorkflowStep = { id: stepId({ raw: 'parsed' }), name: '', type: 'parse_json', source: literal({ value: '1' }) };
    each.body.steps = [baseStep({ type: 'text_generation', id: 'model' }), parsed];
    each.stopWhen = reference({ id: 'parsed', output: 'value' });
    each.emit = reference({ id: 'model', output: 'text' });
    await using run = await runtimeFixture({ definition: { name: '', steps: [each] }, overrides: {} });
    expect(run.result.status).toBe('failed');
    expect(String(run.result.error)).toContain('stop condition must be a boolean');
    expect(run.result.outputs.has(each.id)).toBe(false);
    expect(run.store.getUsage().entries).toBe(0);
  });

  it('rejects malformed budgets before any execution', () => {
    for (const maxLoopIterations of [-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(workflowExecutionLimitIssues({ limits: limits({ overrides: { maxLoopIterations } }) })).not.toEqual([]);
    }
    for (const timeoutMs of [0, -1, 2147483648, Number.NaN]) {
      expect(validateWorkflow({ definition: { name: '', steps: [], executionLimits: limits({ overrides: { timeoutMs } }) } }).some(issue => issue.path === 'executionLimits')).toBe(true);
    }
    expect(workflowExecutionLimitIssues({ limits: limits({ overrides: { maxLoopIterations: 0 } }) })).toEqual([]);
  });
});
