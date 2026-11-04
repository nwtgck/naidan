import type { WorkflowValue } from '@/01-models/workflow';
import { idToRaw } from '@/01-models/ids';
import { lazyStrings } from '@/strings';
import { inferWorkflowValueType, workflowTypeCompatibility, type WorkflowDataType, type WorkflowExpectedType, type WorkflowTypeScope } from './value-types';

export type WorkflowValueInputMode = Exclude<WorkflowValue['type'], 'literal'> | 'text' | 'json' | 'number' | 'boolean';

export function workflowValueMode({ value }: { value: WorkflowValue }): WorkflowValueInputMode {
  switch (value.type) {
  case 'literal':
    switch (typeof value.value) {
    case 'string': return 'text';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    default: return 'json';
    }
  case 'model': case 'step_output': case 'loop_item': case 'loop_index': case 'loop_state': case 'array': case 'object': case 'concat': case 'path': case 'get': case 'filename': case 'format_number': case 'equals': case 'not_empty': case 'conversation': case 'range': case 'json_compose': return value.type;
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
}

export function workflowValueModeLabel({ mode }: { mode: WorkflowValueInputMode }): string | undefined {
  switch (mode) {
  case 'text': return lazyStrings.workflow__literal_text();
  case 'json': return lazyStrings.workflow__literal_json();
  case 'number': return lazyStrings.workflow__number();
  case 'boolean': return lazyStrings.workflow__boolean();
  case 'array': return lazyStrings.workflow__array();
  case 'object': return lazyStrings.workflow__object();
  case 'concat': return lazyStrings.workflow__join_text();
  case 'json_compose': return lazyStrings.workflow__compose_json();
  case 'range': return lazyStrings.workflow__number_range();
  case 'model': return lazyStrings.workflow__model();
  case 'conversation': return lazyStrings.workflow__conversation();
  case 'step_output': return lazyStrings.workflow__step_reference();
  case 'loop_item': return lazyStrings.workflow__loop_item();
  case 'loop_index': return lazyStrings.workflow__loop_index();
  case 'loop_state': return lazyStrings.workflow__loop_state();
  case 'path': return lazyStrings.workflow__path();
  case 'get': return lazyStrings.workflow__get_field();
  case 'filename': return lazyStrings.workflow__file_name();
  case 'format_number': return lazyStrings.workflow__format_number();
  case 'equals': return lazyStrings.workflow__equals();
  case 'not_empty': return lazyStrings.workflow__not_empty();
  default: {
    const exhaustive: never = mode;
    throw new Error(String(exhaustive));
  }
  }
}

function referenceLabel({ name, detail }: { name: string, detail: string | undefined }): string | undefined {
  return detail === undefined ? undefined : `${name} · ${detail}`;
}

export function workflowReferenceChoices({ scope, expected }: { scope: WorkflowTypeScope, expected: WorkflowExpectedType }): { id: string, label: string | undefined, value: WorkflowValue, type: WorkflowDataType }[] {
  const choices: { id: string, label: string | undefined, value: WorkflowValue, type: WorkflowDataType }[] = [];
  for (const [id, entry] of scope.outputs) {
    for (const [output, type] of Object.entries(entry.outputs)) {
      choices.push({ id: JSON.stringify(['output', idToRaw({ id }), output]), label: `${entry.step.name} · ${output}`, value: { type: 'step_output', stepId: id, output }, type });
    }
  }
  for (const [id, entry] of scope.loops) {
    if (entry.item) {
      choices.push({ id: JSON.stringify(['item', idToRaw({ id })]), label: referenceLabel({ name: entry.step.name, detail: lazyStrings.workflow__loop_item() }), value: { type: 'loop_item', stepId: id }, type: entry.item });
    }
    choices.push({ id: JSON.stringify(['index', idToRaw({ id })]), label: referenceLabel({ name: entry.step.name, detail: lazyStrings.workflow__loop_index() }), value: { type: 'loop_index', stepId: id }, type: { kind: 'number' } });
    for (const [key, type] of Object.entries(entry.state)) {
      choices.push({ id: JSON.stringify(['state', idToRaw({ id }), key]), label: `${entry.step.name} · ${key}`, value: { type: 'loop_state', stepId: id, key }, type });
    }
  }
  return choices.filter(choice => workflowTypeCompatibility({ actual: choice.type, expected }) !== 'incompatible');
}

export function newWorkflowValueInput({ mode, scope, expected }: { mode: WorkflowValueInputMode, scope: WorkflowTypeScope, expected: WorkflowExpectedType }): WorkflowValue | undefined {
  switch (mode) {
  case 'text': return { type: 'literal', value: '' };
  case 'number': return { type: 'literal', value: 0 };
  case 'boolean': return { type: 'literal', value: true };
  case 'json':
    switch (expected) {
    case 'iterable': return { type: 'literal', value: [] };
    case 'text': return { type: 'literal', value: '' };
    case 'number': return { type: 'literal', value: 0 };
    case 'boolean': return { type: 'literal', value: true };
    case 'any': case 'json': case 'model': case 'conversation': case 'binary': return { type: 'literal', value: {} };
    default: {
      const exhaustive: never = expected;
      throw new Error(String(exhaustive));
    }
    }
  case 'model': return { type: 'model', endpoint: { type: 'openai', url: '' }, modelId: '' };
  case 'array': case 'concat': case 'path': return { type: mode, items: [] };
  case 'object': return { type: mode, properties: {} };
  case 'json_compose': return { type: mode, base: {}, assignments: [] };
  case 'range': return { type: mode, start: { type: 'literal', value: 0 }, end: { type: 'literal', value: 10 }, step: { type: 'literal', value: 1 } };
  case 'conversation': return { type: mode, messages: [] };
  case 'get': return { type: mode, value: { type: 'literal', value: {} }, path: [] };
  case 'filename': case 'not_empty': return { type: mode, value: { type: 'literal', value: '' } };
  case 'format_number': return { type: mode, value: { type: 'literal', value: 0 }, minDigits: 3 };
  case 'equals': return { type: mode, left: { type: 'literal', value: '' }, right: { type: 'literal', value: '' } };
  case 'step_output': case 'loop_item': case 'loop_index': case 'loop_state': return workflowReferenceChoices({ scope, expected }).find(choice => choice.value.type === mode)?.value;
  default: {
    const exhaustive: never = mode;
    throw new Error(String(exhaustive));
  }
  }
}

export function workflowValueInputOptions({ scope, expected, current }: { scope: WorkflowTypeScope, expected: WorkflowExpectedType, current: WorkflowValue }): { value: WorkflowValueInputMode, label: string | undefined, disabled: boolean }[] {
  const modes: WorkflowValueInputMode[] = ['text', 'number', 'boolean', 'json', 'step_output', 'loop_item', 'loop_index', 'loop_state', 'array', 'range', 'object', 'json_compose', 'get', 'concat', 'path', 'filename', 'format_number', 'equals', 'not_empty', 'model', 'conversation'];
  const options = modes.flatMap(mode => {
    const value = newWorkflowValueInput({ mode, scope, expected });
    // JSON and field projection are general constructors: their final shape is
    // chosen by editing, not by the empty placeholder used for a new expression.
    // An object can construct a model target, but can never become an iterable.
    const actual = (['json', 'json_compose', 'get'].includes(mode) || (mode === 'object' && expected === 'model')) ? { kind: 'unknown' as const } : value && inferWorkflowValueType({ value, scope });
    return value && actual && workflowTypeCompatibility({ actual, expected }) !== 'incompatible' ? [{ value: mode, label: workflowValueModeLabel({ mode }), disabled: false }] : [];
  });
  const mode = workflowValueMode({ value: current });
  if (!options.some(option => option.value === mode)) {
    options.unshift({ value: mode, label: workflowValueModeLabel({ mode }), disabled: true });
  }
  return options;
}

export function workflowValueSummary({ value, scope }: { value: WorkflowValue, scope: WorkflowTypeScope }): string | undefined {
  const reference = workflowReferenceChoices({ scope, expected: 'any' }).find(choice => JSON.stringify(choice.value) === JSON.stringify(value));
  if (reference) {
    return reference.label;
  }
  switch (value.type) {
  case 'literal': return JSON.stringify(value.value).slice(0, 120);
  case 'model': return `${value.endpoint.type} · ${value.modelId}`;
  case 'get': {
    const parent = workflowValueSummary({ value: value.value, scope });
    return parent === undefined ? undefined : `${parent} → ${value.path.join(' · ')}`;
  }
  case 'step_output': case 'loop_item': case 'loop_index': case 'loop_state': case 'array': case 'object': case 'concat': case 'path': case 'filename': case 'format_number': case 'equals': case 'not_empty': case 'conversation': case 'range': case 'json_compose': return workflowValueModeLabel({ mode: workflowValueMode({ value }) });
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
