import { z } from 'zod';
import type { JsonValue } from '@/01-models/lm';
import type { WorkflowDefinition, WorkflowStep, WorkflowValue, WorkflowMessage, WorkflowModelConfiguration } from '@/01-models/workflow';
import { ExperimentalWorkflowDefinitionSchemaDto, ExperimentalWorkflowStepSchemaDto, ExperimentalWorkflowValueSchemaDto, ExperimentalWorkflowModelConfigurationSchemaDto } from '@/00-storage/00-dto/experimental-workflow.dto';
import { workflowDefinitionToDomain, workflowDefinitionToDto, workflowStepToDomain, workflowStepToDto, workflowValueToDomain, workflowValueToDto, workflowModelConfigurationToDomain } from '@/00-storage/mapper/workflow';

export const WORKFLOW_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;

/** Check depth and duplicate keys before recursively validating a document.
 * JSON.parse owns syntax; this scanner only records object keys and nesting. */
export function parseWorkflowJson({ text }: { text: string }): JsonValue {
  if (text.length > WORKFLOW_DOCUMENT_MAX_BYTES || new TextEncoder().encode(text).byteLength > WORKFLOW_DOCUMENT_MAX_BYTES) {
    throw new Error('Workflow JSON exceeds the 2 MiB editing limit.');
  }
  const value: unknown = JSON.parse(text);
  let index = 0;
  function space(): void {
    while (/\s/.test(text[index] ?? '') && index < text.length) {
      index++;
    }
  }
  function string(): string {
    const start = index++;
    while (index < text.length) {
      const c = text[index++];
      if (c === '\\') {
        index++;
        continue;
      }
      if (c === '"') {
        return z.string().parse(JSON.parse(text.slice(start, index)));
      }
    }
    throw new Error('Unterminated JSON string.');
  }
  function visit({ depth }: { depth: number }): void {
    if (depth > 64) {
      throw new Error('Workflow JSON is nested too deeply.');
    }
    space();
    const c = text[index];
    if (c === '"') {
      string();
      return;
    }
    if (c === '{') {
      index++;
      space();
      const keys = new Set<string>();
      while (text[index] !== '}') {
        space();
        const key = string();
        if (keys.has(key)) {
          throw new Error(`Duplicate JSON key: ${key}`);
        }
        keys.add(key);
        space();
        index++;
        visit({ depth: depth + 1 });
        space();
        if (text[index] === ',') {
          index++;
        } else {
          break;
        }
      }
      index++;
      return;
    }
    if (c === '[') {
      index++;
      space();
      while (text[index] !== ']') {
        visit({ depth: depth + 1 });
        space();
        if (text[index] === ',') {
          index++;
        } else {
          break;
        }
      }
      index++;
      return;
    }
    while (index < text.length && !/[\s,}\]]/.test(text[index] ?? '')) {
      index++;
    }
  }
  visit({ depth: 0 });
  return z.json().parse(value);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Storage tolerates newer fields; interactive edits must not silently lose them. */
function assertNoRemovedFields({ input, parsed, path }: { input: unknown, parsed: unknown, path: string }): void {
  if (Array.isArray(input) && Array.isArray(parsed)) {
    input.forEach((item, index) => assertNoRemovedFields({ input: item, parsed: parsed[index], path: `${path}[${index}]` }));
  } else if (object(input) && object(parsed)) {
    for (const key of Object.keys(input)) {
      if (!Object.hasOwn(parsed, key)) {
        throw new Error(`Unknown editing field: ${path}.${key}`);
      }
      assertNoRemovedFields({ input: input[key], parsed: parsed[key], path: `${path}.${key}` });
    }
  }
}

export function parseWorkflowDefinition({ text }: { text: string }): WorkflowDefinition {
  const input = parseWorkflowJson({ text });
  const dto = ExperimentalWorkflowDefinitionSchemaDto.parse(input);
  assertNoRemovedFields({ input, parsed: dto, path: '$' });
  return workflowDefinitionToDomain({ dto });
}

export function formatWorkflowDefinition({ definition }: { definition: WorkflowDefinition }): string {
  return JSON.stringify(workflowDefinitionToDto({ domain: definition }), undefined, 2);
}

export function formatWorkflowStep({ step }: { step: WorkflowStep }): string {
  return JSON.stringify(workflowStepToDto({ domain: step }), undefined, 2);
}

/** Enumerate actual tagged schema positions, not arbitrary keys named "type". */
function stepTags({ step }: { step: WorkflowStep }): Map<string, string> {
  const tags = new Map<string, string>();
  function value({ input, path }: { input: WorkflowValue, path: string[] }): void {
    tags.set(JSON.stringify(path), 'type');
    switch (input.type) {
    case 'literal': case 'step_output': case 'loop_item': case 'loop_index': case 'loop_state': return;
    case 'model':
      tags.set(JSON.stringify([...path, 'endpoint']), 'type');
      tags.set(JSON.stringify([...path, 'endpoint', 'experimental', 'endpoint']), 'type');
      return;
    case 'array': case 'concat': case 'path': case 'all': case 'any': input.items.forEach((item, index) => value({ input: item, path: [...path, 'items', String(index)] }));
      return;
    case 'object': Object.entries(input.properties).forEach(([key, item]) => value({ input: item, path: [...path, 'properties', key] }));
      return;
    case 'json_compose':
      input.assignments.forEach((item, index) => value({ input: item.value, path: [...path, 'assignments', String(index), 'value'] }));
      return;
    case 'range':
      value({ input: input.start, path: [...path, 'start'] });
      value({ input: input.step, path: [...path, 'step'] });
      if (input.end !== undefined) {
        value({ input: input.end, path: [...path, 'end'] });
      }
      return;
    case 'get': case 'filename': case 'not_empty': case 'format_number': case 'not': value({ input: input.value, path: [...path, 'value'] });
      return;
    case 'arithmetic': case 'compare': case 'equals': value({ input: input.left, path: [...path, 'left'] });
      value({ input: input.right, path: [...path, 'right'] });
      return;
    case 'conversation': messages({ items: input.messages, path: [...path, 'messages'] });
      return;
    default: {
      const exhaustive: never = input;
      throw new Error(String(exhaustive));
    }
    }
  }
  function messages({ items, path }: { items: WorkflowMessage[], path: string[] }): void {
    items.forEach((item, i) => item.parts.forEach((part, j) => {
      switch (part.type) {
      case 'text': case 'reasoning':
      case 'tool_call': break;
      case 'tool_result': value({ input: part.content, path: [...path, String(i), 'parts', String(j), 'content'] });
        break;
      case 'value': value({ input: part.value, path: [...path, String(i), 'parts', String(j), 'value'] });
        break;
      default: {
        const exhaustive: never = part;
        throw new Error(`Unknown message part: ${exhaustive}`);
      }
      }
    }));
  }
  // Child Step lists and message parts are arrays and are replaced, never merged.
  function field({ key, input }: { key: string, input: WorkflowValue }): void {
    value({ input, path: [key] });
  }
  switch (step.type) {
  case 'value': field({ key: 'value', input: step.value });
    break;
  case 'model_selection': break;
  case 'parse_json': field({ key: 'source', input: step.source });
    break;
  case 'text_generation':
    field({ key: 'target', input: step.target });
    field({ key: 'conversation', input: step.conversation });
    tags.set(JSON.stringify(['systemPrompt']), 'behavior');
    break;
  case 'audio_generation':
    field({ key: 'modelId', input: step.modelId });
    field({ key: 'text', input: step.text });
    if (step.reference !== undefined) {
      field({ key: 'reference', input: step.reference });
    }
    for (const [key, input] of Object.entries(step.parameters)) {
      value({ input, path: ['parameters', key] });
    }
    break;
  case 'image_generation':
    field({ key: 'model', input: step.model });
    field({ key: 'prompt', input: step.prompt });
    if (step.imageInputs !== undefined) {
      if (step.imageInputs.initImage !== undefined) {
        value({ input: step.imageInputs.initImage, path: ['imageInputs', 'initImage'] });
      }
      value({ input: step.imageInputs.strength, path: ['imageInputs', 'strength'] });
      step.imageInputs.referenceImages.forEach((input, index) => value({ input, path: ['imageInputs', 'referenceImages', String(index)] }));
    }
    if (step.gpuBudgetMiB !== undefined) {
      field({ key: 'gpuBudgetMiB', input: step.gpuBudgetMiB });
    }
    for (const [key, input] of Object.entries(step.parameters)) {
      value({ input, path: ['parameters', key] });
    }
    break;
  case 'tool_call': field({ key: 'arguments', input: step.arguments });
    tags.set(JSON.stringify(['tool']), 'name');
    break;
  case 'request_input': field({ key: 'prompt', input: step.prompt });
    if (step.choices !== undefined) {
      field({ key: 'choices', input: step.choices });
    }
    break;
  case 'if':
    field({ key: 'condition', input: step.condition });
    for (const branch of ['then', 'else'] as const) {
      for (const [key, input] of Object.entries(step[branch].outputs)) {
        value({ input, path: [branch, 'outputs', key] });
      }
    }
    break;
  case 'repeat': case 'for_each':
    switch (step.type) {
    case 'repeat': field({ key: 'count', input: step.count });
      break;
    case 'for_each': field({ key: 'source', input: step.source });
      break;
    default: {
      const exhaustive: never = step;
      throw new Error(`Unknown loop: ${exhaustive}`);
    }
    }
    for (const [key, input] of Object.entries(step.state)) {
      value({ input: input.initial, path: ['state', key, 'initial'] });
      value({ input: input.next, path: ['state', key, 'next'] });
    }
    if (step.emit) {
      field({ key: 'emit', input: step.emit });
    }
    if (step.stopWhen) {
      field({ key: 'stopWhen', input: step.stopWhen });
    }
    break;
  case 'read_file': field({ key: 'relativePath', input: step.relativePath });
    break;
  case 'write_file': field({ key: 'relativePath', input: step.relativePath });
    field({ key: 'source', input: step.source });
    break;
  default: {
    const exhaustive: never = step;
    throw new Error(String(exhaustive));
  }
  }
  return tags;
}

export function applyWorkflowStepJson({ step, text }: { step: WorkflowStep, text: string }): WorkflowStep {
  const patch = parseWorkflowJson({ text });
  if (!object(patch)) {
    throw new Error('A Step update must be a JSON object.');
  }
  const current = workflowStepToDto({ domain: step });
  for (const key of ['id', 'type'] as const) {
    if (Object.hasOwn(patch, key) && patch[key] !== current[key]) {
      throw new Error(`The selected Step's ${key} cannot be replaced.`);
    }
  }
  const tags = stepTags({ step });
  function merge({ base, update, path }: { base: unknown, update: unknown, path: string[] }): unknown {
    if (!object(base) || !object(update)) {
      return update;
    }
    const tag = tags.get(JSON.stringify(path));
    if (tag && Object.hasOwn(update, tag) && update[tag] !== base[tag]) {
      return update;
    }
    return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(update)])].map(key => [key, Object.hasOwn(update, key)
      ? merge({ base: base[key], update: update[key], path: [...path, key] }) : base[key]]));
  }
  const input = merge({ base: current, update: patch, path: [] });
  const dto = ExperimentalWorkflowStepSchemaDto.parse(input);
  assertNoRemovedFields({ input, parsed: dto, path: '$' });
  return workflowStepToDomain({ dto });
}

export function parseWorkflowValue({ text }: { text: string }): WorkflowValue {
  const input = parseWorkflowJson({ text });
  const parsed = ExperimentalWorkflowValueSchemaDto.parse(input);
  assertNoRemovedFields({ input, parsed, path: '$' });
  return workflowValueToDomain({ dto: parsed });
}

export function formatWorkflowValue({ value }: { value: WorkflowValue }): string {
  return JSON.stringify(workflowValueToDto({ domain: value }), null, 2);
}

/** A generic JSON value becomes a model configuration only at this checked boundary. */
export function parseWorkflowModelConfiguration({ value }: { value: JsonValue }): WorkflowModelConfiguration {
  const dto = ExperimentalWorkflowModelConfigurationSchemaDto.parse(value);
  assertNoRemovedFields({ input: value, parsed: dto, path: '$' });
  const model = workflowModelConfigurationToDomain({ dto });
  if (!model.modelId.trim() || model.endpoint.type === 'unsupported_experimental_endpoint') {
    throw new Error('Select a supported model connection before running.');
  }
  return model;
}

export const TEST_ONLY = {
};
