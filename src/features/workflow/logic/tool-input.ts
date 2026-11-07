import { z } from 'zod';
import type { WorkflowToolSelection, WorkflowValue, WorkflowStep } from '@/01-models/workflow';
import { idToRaw, type VolumeId } from '@/01-models/ids';
import { CalculatorArgsSchema } from '@/features/tools/calculator/parameters';
import { WikipediaSearchArgsSchema, WikipediaGetPageArgsSchema } from '@/features/tools/wikipedia/schemas';

/** Explicit time/output budgets and exactly one selected Volume. Cancellation
 * is cooperative; retirement may take longer than the requested timeout. */
export const workflowShellArgsSchema = z.object({
  shell_script: z.string().min(1).max(65536).refine(value => new TextEncoder().encode(value).byteLength <= 65536, 'Script exceeds 64 KiB.'),
  stdout_limit: z.number().int().min(1).max(1024 * 1024).default(16384),
  stderr_limit: z.number().int().min(1).max(1024 * 1024).default(8192),
  timeout_ms: z.number().int().min(1).max(600000).default(8000),
}).strict();

export type WorkflowToolRequest =
  | { name: 'calculator', args: z.infer<typeof CalculatorArgsSchema> }
  | { name: 'wikipedia_search', args: z.infer<typeof WikipediaSearchArgsSchema> }
  | { name: 'wikipedia_get_page', args: z.infer<typeof WikipediaGetPageArgsSchema> }
  | { name: 'shell_execute', volumeId: VolumeId, access: 'read-only' | 'read-write', args: z.infer<typeof workflowShellArgsSchema> };

export function workflowToolArgumentsSchema({ name }: { name: WorkflowToolSelection['name'] }) {
  switch (name) {
  case 'calculator': return CalculatorArgsSchema;
  case 'wikipedia_search': return WikipediaSearchArgsSchema;
  case 'wikipedia_get_page': return WikipediaGetPageArgsSchema;
  case 'shell_execute': return workflowShellArgsSchema;
  default: {
    const exhaustive: never = name;
    throw new Error(String(exhaustive));
  }
  }
}

/** Pure field view shared by the editor and static type analysis. Rendering
 * an imported literal object must not rewrite it or authorize any capability. */
export function workflowToolArgumentFields({ value }: { value: WorkflowValue }): Record<string, WorkflowValue> | undefined {
  switch (value.type) {
  case 'object': return value.properties;
  case 'literal': return value.value !== null && typeof value.value === 'object' && !Array.isArray(value.value)
    ? Object.fromEntries(Object.entries(value.value).map(([key, item]) => [key, { type: 'literal', value: item }]))
    : undefined;
  case 'model': case 'step_output': case 'loop_item': case 'loop_index': case 'loop_state': case 'array': case 'concat': case 'path': case 'json_compose': case 'range': case 'get': case 'filename': case 'format_number': case 'equals': case 'arithmetic': case 'compare': case 'all': case 'any': case 'not': case 'not_empty': case 'conversation': return undefined;
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
}

export function workflowToolArgumentKinds({ name }: { name: WorkflowToolSelection['name'] }): Record<string, 'text' | 'number' | 'json'> {
  switch (name) {
  case 'calculator': return { expression: 'text', output: 'json' };
  case 'wikipedia_search': return { lang: 'text', query: 'text' };
  case 'wikipedia_get_page': return { lang: 'text', pageId: 'number' };
  case 'shell_execute': return { shell_script: 'text', stdout_limit: 'number', stderr_limit: 'number', timeout_ms: 'number' };
  default: {
    const exhaustive: never = name;
    throw new Error(String(exhaustive));
  }
  }
}

/** Inspect authored fields without evaluating references or erasing their origin. */
export function workflowToolLiteralIssues({ step }: { step: Extract<WorkflowStep, { type: 'tool_call' }> }): { path: string, message: string }[] {
  const schema = workflowToolArgumentsSchema({ name: step.tool.name });
  const args = step.arguments;
  switch (args.type) {
  case 'literal': {
    const parsed = schema.safeParse(args.value);
    return parsed.success ? [] : parsed.error.issues.map(issue => ({ path: ['arguments', ...issue.path].join('.'), message: issue.message }));
  }
  case 'object': break;
  case 'model': case 'step_output': case 'loop_item': case 'loop_index': case 'loop_state': case 'array': case 'concat': case 'path': case 'json_compose': case 'range': case 'get': case 'filename': case 'format_number': case 'equals': case 'arithmetic': case 'compare': case 'all': case 'any': case 'not': case 'not_empty': case 'conversation': return [];
  default: {
    const exhaustive: never = args;
    throw new Error(String(exhaustive));
  }
  }
  const fields: Record<string, z.ZodType> = schema.shape;
  const issues: { path: string, message: string }[] = [];
  for (const [key, field] of Object.entries(fields)) {
    const value = Object.hasOwn(args.properties, key) ? args.properties[key] : undefined;
    if (value !== undefined && value.type !== 'literal') {
      continue;
    }
    const parsed = field.safeParse(value?.value);
    if (!parsed.success) {
      issues.push(...parsed.error.issues.map(issue => ({ path: ['arguments', key, ...issue.path].join('.'), message: issue.message })));
    }
  }
  for (const key of Object.keys(args.properties)) {
    if (!Object.hasOwn(fields, key)) {
      issues.push({ path: `arguments.${key}`, message: 'Unknown tool argument.' });
    }
  }
  return issues;
}

/** Resolve defaults before review. Neither persisted JSON nor the tool can widen
 * the reviewed capability by supplying arbitrary tool names or global mounts. */
export function resolveWorkflowToolRequest({ tool, args }: { tool: WorkflowToolSelection, args: unknown }): WorkflowToolRequest {
  const encoded = JSON.stringify(args);
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > 128 * 1024) {
    throw new Error('Tool arguments exceed 128 KiB.');
  }
  switch (tool.name) {
  case 'calculator': return { name: tool.name, args: CalculatorArgsSchema.parse(args) };
  case 'wikipedia_search': return { name: tool.name, args: WikipediaSearchArgsSchema.parse(args) };
  case 'wikipedia_get_page': return { name: tool.name, args: WikipediaGetPageArgsSchema.parse(args) };
  case 'shell_execute':
    if (!idToRaw({ id: tool.volumeId }).trim()) {
      throw new Error('Select a shell folder before running.');
    }
    return { name: tool.name, volumeId: tool.volumeId, access: z.enum(['read-only', 'read-write']).parse(tool.access), args: workflowShellArgsSchema.parse(args) };
  default: {
    const exhaustive: never = tool;
    throw new Error(String(exhaustive));
  }
  }
}

export function defaultWorkflowToolArguments({ name }: { name: WorkflowToolSelection['name'] }): WorkflowValue {
  switch (name) {
  case 'calculator': return { type: 'object', properties: { expression: { type: 'literal', value: '1 + 1' } } };
  case 'wikipedia_search': return { type: 'object', properties: { lang: { type: 'literal', value: 'en' }, query: { type: 'literal', value: '' } } };
  case 'wikipedia_get_page': return { type: 'object', properties: { lang: { type: 'literal', value: 'en' }, pageId: { type: 'literal', value: 1 } } };
  case 'shell_execute': return { type: 'object', properties: { shell_script: { type: 'literal', value: 'ls' }, stdout_limit: { type: 'literal', value: 16384 }, stderr_limit: { type: 'literal', value: 8192 }, timeout_ms: { type: 'literal', value: 8000 } } };
  default: {
    const exhaustive: never = name;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
