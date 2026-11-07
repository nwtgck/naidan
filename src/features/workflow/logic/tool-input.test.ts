import type { WorkflowValue } from '@/01-models/workflow';
import { it, expect, vi } from 'vitest';
import { toVolumeId } from '@/01-models/ids';
import { parseWorkflowDefinition, formatWorkflowDefinition, applyWorkflowStepJson } from '@/00-storage/service/workflow-json';
import { validateWorkflow, copyWorkflowSteps, workflowOutputNames } from './definition';
import { resolveWorkflowToolRequest } from './tool-input';
import { toolStep, toolRequest } from './tool.test-support';
import { runtimeFixture, literal, reference, valueStep, baseStep } from './workflow.test-support';
import type { WorkflowRuntimeServices } from './runtime';
import { isDefinitionWorkflowTarget } from './provenance';
import { executeWorkflowTool } from './tool-execution';
import { executeWorkflowBuiltinTool } from '@/features/workflow/providers/tools';
import { analyzeWorkflowTypes, inferWorkflowValueType } from './value-types';
import { DEFAULT_WORKFLOW_EXECUTION_LIMITS, WorkflowExecutionLimitError } from './execution-control';
import { readText } from './values';

it.each(['calculator', 'wikipedia_search', 'wikipedia_get_page', 'shell_execute'] as const)('round-trips the %s capability and its inputs without authority fields', name => {
  const step = toolStep({ id: 'call', request: toolRequest({ name }), onError: 'fail' });
  const definition = { name: 'Tool', steps: [step] };
  expect(parseWorkflowDefinition({ text: formatWorkflowDefinition({ definition }) })).toEqual(definition);
  expect(validateWorkflow({ definition })).toEqual([]);
  expect(workflowOutputNames({ step })).toEqual(['text', 'ok', 'metadata']);
});

it.each([
  { shell_script: 'ls', timeout_ms: 0 },
  { shell_script: 'ls', timeout_ms: 600001 },
  { shell_script: 'ls', stdout_limit: -1 },
  { shell_script: 'ls', stderr_limit: 1048577 },
  { shell_script: 'ls', stdout_limit: 1.2 },
  { shell_script: 'ls', timeout_ms: '8000' },
  { shell_script: '猫'.repeat(30000) },
  { shell_script: 'ls', mounts: ['/secret'] },
])('rejects invalid shell arguments before acquiring resources: %j', args => {
  const tool = { name: 'shell_execute' as const, volumeId: toVolumeId({ raw: 'folder' }), access: 'read-only' as const };
  expect(() => resolveWorkflowToolRequest({ tool, args })).toThrow();
});

it('resolves shell defaults before approval and rejects an empty folder', () => {
  const tool = { name: 'shell_execute' as const, volumeId: toVolumeId({ raw: 'folder' }), access: 'read-only' as const };
  expect(resolveWorkflowToolRequest({ tool, args: { shell_script: 'pwd' } })).toEqual(toolRequest({ name: 'shell_execute' }));
  expect(() => resolveWorkflowToolRequest({ tool: { ...tool, volumeId: toVolumeId({ raw: '' }) }, args: { shell_script: 'ls' } })).toThrow('folder');
});

it.each([
  ['calculator', { expression: '1', callback: 'unsafe' }],
  ['wikipedia_search', { lang: 'en.example.com', query: 'x' }],
  ['wikipedia_search', { lang: 'en', query: 'x', url: 'https://other.invalid' }],
  ['wikipedia_get_page', { lang: 'en', pageId: '12' }],
  ['wikipedia_get_page', { lang: 'en', pageId: -1 }],
] as const)('uses the actual tool schema for %s', (name, args) => {
  expect(() => resolveWorkflowToolRequest({ tool: { name }, args })).toThrow();
});

it('removes obsolete capability fields when partial JSON changes shell into calculator', () => {
  const step = toolStep({ id: 'call', request: toolRequest({ name: 'shell_execute' }), onError: 'fail' });
  const changed = applyWorkflowStepJson({ step, text: '{"tool":{"name":"calculator"},"arguments":{"type":"literal","value":{"expression":"2+3"}}}' });
  expect(changed).toMatchObject({ tool: { name: 'calculator' }, arguments: { type: 'literal', value: { expression: '2+3' } } });
  if (changed.type !== 'tool_call') {
    throw new Error('Expected tool call');
  }
  expect(Object.keys(changed.tool)).toEqual(['name']);
});

it('rewires references throughout tool arguments when duplicating a part', () => {
  const source = valueStep({ id: 'source', value: literal({ value: '1 + 2' }) });
  const step = toolStep({ id: 'call', request: toolRequest({ name: 'calculator' }), onError: 'fail' });
  step.arguments = { type: 'object', properties: { expression: reference({ id: 'source', output: 'value' }) } };
  const copies = copyWorkflowSteps({ steps: [source, step] });
  expect(copies[1]).toMatchObject({ arguments: { properties: { expression: { stepId: copies[0]!.id } } } });
  expect(copies[0]!.id).not.toBe(source.id);
});

it('executes dynamic arithmetic inputs through the real calculator without a model or approval', async () => {
  const step = toolStep({ id: 'call', request: toolRequest({ name: 'calculator' }), onError: 'fail' });
  step.arguments = { type: 'object', properties: { expression: reference({ id: 'source', output: 'value' }) } };
  const authorize = vi.fn(async () => true);
  await using run = await runtimeFixture({
    definition: { name: '', steps: [valueStep({ id: 'source', value: literal({ value: '1 / 3' }) }), step] },
    overrides: { callTool: ({ input }) => executeWorkflowTool({ input, authorize, execute: executeWorkflowBuiltinTool }) },
  });
  expect(run.result.status, String(run.result.error)).toBe('completed');
  expect(await readText({ value: run.result.outputs.get(step.id)!.text!, signal: undefined, maxBytes: 1024 })).toContain('0.333333333333333');
  expect(run.result.outputs.get(step.id)!.ok).toEqual({ type: 'json', value: true });
  expect(authorize).not.toHaveBeenCalled();
});

it('rejects invalid evaluated arguments before calling any tool service', async () => {
  const step = toolStep({ id: 'call', request: toolRequest({ name: 'wikipedia_search' }), onError: 'continue' });
  step.arguments = reference({ id: 'source', output: 'value' });
  const callTool = vi.fn<WorkflowRuntimeServices['callTool']>(async () => ({}));
  await using run = await runtimeFixture({ definition: { name: '', steps: [valueStep({ id: 'source', value: { type: 'literal', value: { lang: 'en', query: '', extra: true } } }), step] }, overrides: { callTool } });
  expect(run.result.status).toBe('failed');
  expect(callTool).not.toHaveBeenCalled();
});

it('keeps tool output untrusted through JSON parsing, projection, and a model target', async () => {
  const call = toolStep({ id: 'call', request: toolRequest({ name: 'calculator' }), onError: 'fail' });
  const parsed = { type: 'parse_json' as const, id: valueStep({ id: 'parsed', value: literal({ value: '' }) }).id, name: '', source: reference({ id: 'call', output: 'text' }) };
  const generateStep = baseStep({ type: 'text_generation', id: 'generate' });
  if (generateStep.type !== 'text_generation') {
    throw new Error('Expected generation');
  }
  generateStep.target = { type: 'get', value: reference({ id: 'parsed', output: 'value' }), path: ['target'] };
  const generate = vi.fn<WorkflowRuntimeServices['generate']>(async () => ({}));
  await using run = await runtimeFixture({
    definition: { name: '', steps: [call, parsed, generateStep] },
    overrides: { generate, callTool: async () => ({ text: { type: 'json', value: JSON.stringify({ target: { endpoint: { type: 'ollama', url: 'http://localhost:11434' }, modelId: 'untrusted' }, trusted: true }) } }) },
  });
  expect(run.result.status, String(run.result.error)).toBe('completed');
  expect(generate.mock.calls[0]![0].input.targetSources).toContain('tool_output');
  expect(isDefinitionWorkflowTarget({ sources: generate.mock.calls[0]![0].input.targetSources })).toBe(false);
});

export const TEST_ONLY = {
};

const invalidToolArguments: WorkflowValue[] = [
  { type: 'literal' as const, value: { lang: 'en' } },
  { type: 'object' as const, properties: { lang: { type: 'literal' as const, value: 'en' } } },
  { type: 'object' as const, properties: { lang: { type: 'literal' as const, value: 'en' }, query: { type: 'literal' as const, value: 'x' }, url: { type: 'literal' as const, value: 'other' } } },
];

it.each(invalidToolArguments)('reports statically invalid tool arguments without running a tool: %j', args => {
  const step = toolStep({ id: 'call', request: toolRequest({ name: 'wikipedia_search' }), onError: 'continue' });
  step.arguments = args;
  expect(validateWorkflow({ definition: { name: '', steps: [step] } }).length).toBeGreaterThan(0);
});

it('offers typed search results to a loop instead of treating the whole metadata as opaque JSON', () => {
  const search = toolStep({ id: 'search', request: toolRequest({ name: 'wikipedia_search' }), onError: 'fail' });
  const each = baseStep({ type: 'for_each', id: 'each' });
  if (each.type !== 'for_each') {
    throw new Error('Expected loop');
  }
  each.source = { type: 'get', value: reference({ id: 'search', output: 'metadata' }), path: ['items'] };
  const page = toolStep({ id: 'page', request: toolRequest({ name: 'wikipedia_get_page' }), onError: 'fail' });
  page.arguments = { type: 'object', properties: { lang: { type: 'get', value: { type: 'loop_item', stepId: each.id }, path: ['lang'] }, pageId: { type: 'get', value: { type: 'loop_item', stepId: each.id }, path: ['pageId'] } } };
  each.body.steps = [page];
  const analysis = analyzeWorkflowTypes({ definition: { name: '', steps: [search, each] } });
  expect(analysis.problems).toEqual([]);
  expect(analysis.inputs.get(page.id)?.loops.get(each.id)?.item).toEqual({ kind: 'object', fields: { lang: { kind: 'text' }, pageId: { kind: 'number' }, title: { kind: 'text' } } });
});

it('allows continued error codes without falsely guaranteeing successful-only metadata fields', () => {
  const search = toolStep({ id: 'search', request: toolRequest({ name: 'wikipedia_search' }), onError: 'continue' });
  const after = valueStep({ id: 'after', value: { type: 'get', value: reference({ id: 'search', output: 'metadata' }), path: ['code'] } });
  const analysis = analyzeWorkflowTypes({ definition: { name: '', steps: [search, after] } });
  expect(analysis.problems).toEqual([]);
  expect(inferWorkflowValueType({ value: after.value, scope: analysis.inputs.get(after.id)! })).toEqual({ kind: 'unknown' });
  expect(inferWorkflowValueType({ value: { type: 'get', value: reference({ id: 'search', output: 'metadata' }), path: ['items'] }, scope: analysis.inputs.get(after.id)! })).toEqual({ kind: 'unknown' });
});

it('charges tool calls to the existing execution-wide step budget', async () => {
  const one = toolStep({ id: 'first', request: toolRequest({ name: 'calculator' }), onError: 'fail' });
  const two = toolStep({ id: 'second', request: toolRequest({ name: 'calculator' }), onError: 'fail' });
  const callTool = vi.fn<WorkflowRuntimeServices['callTool']>(async () => ({}));
  await using run = await runtimeFixture({ definition: { name: '', steps: [one, two], executionLimits: { ...DEFAULT_WORKFLOW_EXECUTION_LIMITS, maxStepExecutions: 1 } }, overrides: { callTool } });
  expect(run.result.status).toBe('failed');
  expect(run.result.error).toBeInstanceOf(WorkflowExecutionLimitError);
  expect(callTool).toHaveBeenCalledOnce();
});

it('drains a tool after the workflow deadline, reports budget failure, and keeps prior completed outputs', async () => {
  vi.useFakeTimers();
  using clock = {
    [Symbol.dispose]() {
      vi.useRealTimers();
    },
  };
  const entered = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  const step = toolStep({ id: 'calculate', request: toolRequest({ name: 'calculator' }), onError: 'continue' });
  let settled = false;
  let toolSignal: AbortSignal | undefined;
  const pending = runtimeFixture({
    definition: { name: '', steps: [valueStep({ id: 'before', value: literal({ value: 'keep' }) }), step], executionLimits: { ...DEFAULT_WORKFLOW_EXECUTION_LIMITS, timeoutMs: 100 } },
    overrides: {
      callTool: ({ input }) => executeWorkflowTool({
        input,
        authorize: async () => true,
        execute: async ({ signal }) => {
          toolSignal = signal;
          entered.resolve();
          await done.promise;
          return { outcome: { status: 'success', content: 'late' }, metadata: {} };
        },
      }),
    },
  }).then(run => {
    settled = true;
    return run;
  });
  await using owner = {
    async [Symbol.asyncDispose]() {
      done.resolve();
      const run = await pending;
      await run[Symbol.asyncDispose]();
    },
  };
  await entered.promise;
  await vi.advanceTimersByTimeAsync(100);
  expect(toolSignal?.aborted).toBe(true);
  expect(settled).toBe(false);
  done.resolve();
  const run = await pending;
  expect(run.result.status).toBe('failed');
  expect(run.result.error).toBeInstanceOf(WorkflowExecutionLimitError);
  expect(run.result.outputs.get(step.id)).toBeUndefined();
  expect(run.result.outputs.get(valueStep({ id: 'before', value: literal({ value: '' }) }).id)?.value).toEqual({ type: 'json', value: 'keep' });
  void clock;
  void owner;
});

it('rejects a known numeric output wired to a text tool field before external execution', () => {
  const source = valueStep({ id: 'source', value: literal({ value: 12 }) });
  const page = toolStep({ id: 'page', request: toolRequest({ name: 'wikipedia_get_page' }), onError: 'fail' });
  page.arguments = { type: 'object', properties: { lang: reference({ id: 'source', output: 'value' }), pageId: literal({ value: 12 }) } };
  expect(validateWorkflow({ definition: { name: '', steps: [source, page] } }).some(issue => issue.path.includes('arguments.lang'))).toBe(true);
});
