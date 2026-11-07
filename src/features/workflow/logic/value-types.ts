import { workflowToolArgumentFields, workflowToolArgumentKinds } from './tool-input';
import { workflowImageParameterKeys, workflowImageParameterType } from './image-input';
import type { JsonValue } from '@/01-models/lm';
import type { WorkflowDefinition, WorkflowStep, WorkflowValue } from '@/01-models/workflow';
import type { WorkflowStepId } from '@/01-models/ids';

/** These are input/output contracts, not persisted tags or permission grants.
 * Unknown data remains usable, but never masquerades as a statically checked value.
 */
export type WorkflowDataType =
  | { kind: 'unknown' }
  | { kind: 'text' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'null' }
  | { kind: 'model' }
  | { kind: 'conversation' }
  | { kind: 'binary' }
  | { kind: 'array' | 'sequence', item: WorkflowDataType }
  | { kind: 'object', fields: Record<string, WorkflowDataType> }
  | { kind: 'union', options: WorkflowDataType[] };
export type WorkflowExpectedType = 'any' | 'text' | 'number' | 'boolean' | 'iterable' | 'model' | 'conversation' | 'binary' | 'json';
export type WorkflowTypeScope = {
  outputs: Map<WorkflowStepId, { step: WorkflowStep, outputs: Record<string, WorkflowDataType> }>,
  loops: Map<WorkflowStepId, { step: WorkflowStep, item: WorkflowDataType | undefined, state: Record<string, WorkflowDataType> }>,
};
/** An exact expression address inside its owning Step, never a path into literal JSON.
 * The scope is captured at evaluation time, not the mutable end-of-block scope.
 */
export type WorkflowValueBinding = {
  location: readonly (string | number)[],
  path: string,
  value: WorkflowValue,
  expected: WorkflowExpectedType,
  scope: WorkflowTypeScope,
};
export type WorkflowTypeProblem = { stepId: WorkflowStepId, path: string, message: string };
const unknownType: WorkflowDataType = { kind: 'unknown' };

export function emptyWorkflowTypeScope(): WorkflowTypeScope {
  return { outputs: new Map(), loops: new Map() };
}

export function joinWorkflowTypes({ types }: { types: WorkflowDataType[] }): WorkflowDataType {
  const options: WorkflowDataType[] = [];
  const seen = new Set<string>();
  const pending = [...types];
  while (pending.length) {
    const type = pending.shift()!;
    switch (type.kind) {
    case 'union': pending.unshift(...type.options);
      continue;
    case 'unknown': return unknownType;
    case 'text': case 'number': case 'boolean': case 'null': case 'model': case 'conversation': case 'binary': case 'array': case 'sequence': case 'object': break;
    default: {
      const exhaustive: never = type;
      throw new Error(String(exhaustive));
    }
    }
    const key = JSON.stringify(type);
    if (!seen.has(key)) {
      seen.add(key);
      options.push(type);
    }
  }
  return options.length === 0 ? unknownType : options.length === 1 ? options[0]! : { kind: 'union', options };
}

export function jsonWorkflowType({ value }: { value: JsonValue }): WorkflowDataType {
  if (value === null) {
    return { kind: 'null' };
  }
  if (typeof value === 'string') {
    return { kind: 'text' };
  }
  if (typeof value === 'number') {
    return { kind: 'number' };
  }
  if (typeof value === 'boolean') {
    return { kind: 'boolean' };
  }
  if (Array.isArray(value)) {
    return { kind: 'array', item: joinWorkflowTypes({ types: value.map(value => jsonWorkflowType({ value })) }) };
  }
  return { kind: 'object', fields: Object.fromEntries(Object.entries(value).map(([key, value]) => [key, jsonWorkflowType({ value })])) };
}

export function workflowItemType({ type }: { type: WorkflowDataType }): WorkflowDataType {
  switch (type.kind) {
  case 'array': case 'sequence': return type.item;
  case 'union': return joinWorkflowTypes({ types: type.options.map(type => workflowItemType({ type })) });
  case 'unknown': case 'text': case 'number': case 'boolean': case 'null': case 'model': case 'conversation': case 'binary': case 'object': return unknownType;
  default: {
    const exhaustive: never = type;
    throw new Error(String(exhaustive));
  }
  }
}

export function workflowFieldType({ type, path }: { type: WorkflowDataType, path: readonly (string | number)[] }): WorkflowDataType {
  if (path.length === 0) {
    return type;
  }
  switch (type.kind) {
  case 'union': return joinWorkflowTypes({ types: type.options.map(type => workflowFieldType({ type, path })) });
  case 'unknown': case 'text': case 'number': case 'boolean': case 'null': case 'model': case 'conversation': case 'binary': case 'array': case 'sequence': case 'object': break;
  default: {
    const exhaustive: never = type;
    throw new Error(String(exhaustive));
  }
  }
  const [key, ...rest] = path;
  if (type.kind === 'object' && typeof key === 'string' && Object.hasOwn(type.fields, key)) {
    return workflowFieldType({ type: type.fields[key]!, path: rest });
  }
  if (type.kind === 'model' && key === 'modelId') {
    return workflowFieldType({ type: { kind: 'text' }, path: rest });
  }
  if (type.kind === 'array' && typeof key === 'number' && Number.isSafeInteger(key) && key >= 0) {
    return workflowFieldType({ type: type.item, path: rest });
  }
  return unknownType;
}

function assignType({ type, path, replacement }: { type: WorkflowDataType, path: readonly (string | number)[], replacement: WorkflowDataType }): WorkflowDataType {
  const [key, ...rest] = path;
  if (key === undefined) {
    return replacement;
  }
  if (type.kind === 'object' && typeof key === 'string') {
    const child = Object.hasOwn(type.fields, key) ? type.fields[key]! : unknownType;
    return { kind: 'object', fields: { ...type.fields, [key]: assignType({ type: child, path: rest, replacement }) } };
  }
  if (type.kind === 'array' && typeof key === 'number') {
    return { kind: 'array', item: joinWorkflowTypes({ types: [type.item, assignType({ type: type.item, path: rest, replacement })] }) };
  }
  return unknownType;
}

export function inferWorkflowValueType({ value, scope }: { value: WorkflowValue, scope: WorkflowTypeScope }): WorkflowDataType {
  const infer = ({ value }: { value: WorkflowValue }) => inferWorkflowValueType({ value, scope });
  switch (value.type) {
  case 'literal': return jsonWorkflowType({ value: value.value });
  case 'model': return { kind: 'model' };
  case 'conversation': return { kind: 'conversation' };
  case 'step_output': return scope.outputs.get(value.stepId)?.outputs[value.output] ?? unknownType;
  case 'loop_item': return scope.loops.get(value.stepId)?.item ?? unknownType;
  case 'loop_index': case 'arithmetic': return { kind: 'number' };
  case 'format_number': return { kind: 'text' };
  case 'loop_state': return scope.loops.get(value.stepId)?.state[value.key] ?? unknownType;
  case 'range': return { kind: 'sequence', item: { kind: 'number' } };
  case 'array': return { kind: 'array', item: joinWorkflowTypes({ types: value.items.map(value => infer({ value })) }) };
  case 'object': return { kind: 'object', fields: Object.fromEntries(Object.entries(value.properties).map(([key, value]) => [key, infer({ value })])) };
  case 'json_compose': {
    let type = jsonWorkflowType({ value: value.base });
    for (const assignment of value.assignments) {
      type = assignType({ type, path: assignment.path, replacement: infer({ value: assignment.value }) });
    }
    return type;
  }
  case 'get': return workflowFieldType({ type: infer({ value: value.value }), path: value.path });
  case 'concat': case 'path': case 'filename': return { kind: 'text' };
  case 'equals': case 'not_empty': case 'compare': case 'all': case 'any': case 'not': return { kind: 'boolean' };
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
}

export function workflowTypeCompatibility({ actual, expected }: { actual: WorkflowDataType, expected: WorkflowExpectedType }): 'compatible' | 'unknown' | 'incompatible' {
  switch (expected) {
  case 'any': return 'compatible';
  case 'text': case 'number': case 'boolean': case 'iterable': case 'model': case 'conversation': case 'binary': case 'json': break;
  default: {
    const exhaustive: never = expected;
    throw new Error(String(exhaustive));
  }
  }
  switch (actual.kind) {
  case 'unknown': return 'unknown';
  case 'union': {
    const results = actual.options.map(actual => workflowTypeCompatibility({ actual, expected }));
    if (results.every(result => result === 'compatible')) {
      return 'compatible';
    }
    if (results.every(result => result === 'incompatible')) {
      return 'incompatible';
    }
    return 'unknown';
  }
  case 'text': case 'number': case 'boolean': case 'null': case 'model': case 'conversation': case 'binary': case 'array': case 'sequence': case 'object': break;
  default: {
    const exhaustive: never = actual;
    throw new Error(String(exhaustive));
  }
  }
  switch (expected) {
  case 'iterable': return actual.kind === 'array' || actual.kind === 'sequence' ? 'compatible' : 'incompatible';
  case 'json': {
    let children: WorkflowDataType[];
    switch (actual.kind) {
    case 'model': case 'binary': case 'conversation': case 'sequence': return 'incompatible';
    case 'object': children = Object.values(actual.fields);
      break;
    case 'array': children = [actual.item];
      break;
    case 'text': case 'number': case 'boolean': case 'null': return 'compatible';
    default: {
      const exhaustive: never = actual;
      throw new Error(String(exhaustive));
    }
    }
    const results = children.map(actual => workflowTypeCompatibility({ actual, expected: 'json' }));
    return results.includes('incompatible') ? 'incompatible' : results.includes('unknown') ? 'unknown' : 'compatible';
  }
  case 'model': {
    switch (actual.kind) {
    case 'model': return 'compatible';
    case 'object': {
      // Shape evidence guides editing, but the consumer still validates Endpoint
      // and model ID. A structural type is never a permission grant.
      if (!Object.hasOwn(actual.fields, 'endpoint') || !Object.hasOwn(actual.fields, 'modelId')) {
        return 'incompatible';
      }
      const id = workflowTypeCompatibility({ actual: actual.fields.modelId!, expected: 'text' });
      return id === 'incompatible' || !['object', 'unknown', 'union'].includes(actual.fields.endpoint!.kind) ? 'incompatible' : 'unknown';
    }
    case 'text': case 'number': case 'boolean': case 'null': case 'conversation': case 'binary': case 'array': case 'sequence': return 'incompatible';
    default: {
      const exhaustive: never = actual;
      throw new Error(String(exhaustive));
    }
    }
  }
  case 'text': case 'number': case 'boolean': case 'conversation': case 'binary': return actual.kind === expected ? 'compatible' : 'incompatible';
  default: {
    const exhaustive: never = expected;
    throw new Error(String(exhaustive));
  }
  }
}

function fileSourceType({ format }: { format: Extract<WorkflowStep, { type: 'write_file' }>['format'] }): WorkflowExpectedType {
  switch (format) {
  case 'text': return 'text';
  case 'binary': return 'binary';
  case 'jsonl': return 'iterable';
  case 'json': return 'json';
  default: {
    const exhaustive: never = format;
    throw new Error(String(exhaustive));
  }
  }
}

/** Shared by preflight validation and contextual editor suggestions. */
export function analyzeWorkflowTypes({ definition }: { definition: WorkflowDefinition }): {
  inputs: Map<WorkflowStepId, WorkflowTypeScope>, bodies: Map<WorkflowStepId, WorkflowTypeScope>, branches: Map<WorkflowStepId, { then: WorkflowTypeScope, else: WorkflowTypeScope }>, problems: WorkflowTypeProblem[],
  valueBindings: Map<WorkflowStepId, WorkflowValueBinding[]>, outputTypes: Map<WorkflowStepId, Record<string, WorkflowDataType>>,
} {
  const inputs = new Map<WorkflowStepId, WorkflowTypeScope>(), bodies = new Map<WorkflowStepId, WorkflowTypeScope>();
  const branches = new Map<WorkflowStepId, { then: WorkflowTypeScope, else: WorkflowTypeScope }>();
  const problems: WorkflowTypeProblem[] = [];
  const bindingMaps = new Map<WorkflowStepId, Map<string, WorkflowValueBinding>>();
  const outputTypes = new Map<WorkflowStepId, Record<string, WorkflowDataType>>();
  function check({ step, value, expected, scope, path, location }: { step: WorkflowStep, value: WorkflowValue, expected: WorkflowExpectedType, scope: WorkflowTypeScope, path: string, location: readonly (string | number)[] | undefined }): void {
    if (location !== undefined) {
      const bindings = bindingMaps.get(step.id) ?? new Map<string, WorkflowValueBinding>();
      bindings.set(JSON.stringify(location), { location, path, value, expected, scope });
      bindingMaps.set(step.id, bindings);
    }
    const actual = inferWorkflowValueType({ value, scope });
    const compatibility = workflowTypeCompatibility({ actual, expected });
    switch (compatibility) {
    case 'incompatible': problems.push({ stepId: step.id, path, message: `Expected ${expected}; this expression produces ${actual.kind}.` });
      break;
    case 'compatible': case 'unknown': break;
    default: {
      const exhaustive: never = compatibility;
      throw new Error(String(exhaustive));
    }
    }
    const child = ({ value, expected, key, suffix }: { value: WorkflowValue, expected: WorkflowExpectedType, key: string, suffix: readonly (string | number)[] }) => check({ step, value, expected, scope, path: `${path}.${key}`, location: location === undefined ? undefined : [...location, ...suffix] });
    switch (value.type) {
    case 'range':
      child({ value: value.start, expected: 'number', key: 'start', suffix: ['start'] });
      child({ value: value.step, expected: 'number', key: 'step', suffix: ['step'] });
      if (value.end !== undefined) {
        child({ value: value.end, expected: 'number', key: 'end', suffix: ['end'] });
      }
      break;
    case 'concat': case 'path': value.items.forEach((value, index) => child({ value, expected: 'text', key: `items[${index}]`, suffix: ['items', index] }));
      break;
    case 'array': value.items.forEach((value, index) => child({ value, expected: 'any', key: `items[${index}]`, suffix: ['items', index] }));
      break;
    case 'object': Object.entries(value.properties).forEach(([key, value]) => child({ value, expected: 'any', key, suffix: ['properties', key] }));
      break;
    case 'json_compose': value.assignments.forEach((item, index) => child({ value: item.value, expected: 'json', key: `assignments[${index}]`, suffix: ['assignments', index, 'value'] }));
      break;
    case 'filename': child({ value: value.value, expected: 'text', key: 'value', suffix: ['value'] });
      break;
    case 'format_number': child({ value: value.value, expected: 'number', key: 'value', suffix: ['value'] });
      break;
    case 'get': {
      child({ value: value.value, expected: 'any', key: 'value', suffix: ['value'] });
      let type = inferWorkflowValueType({ value: value.value, scope });
      for (const key of value.path) {
        if (type.kind === 'object' && (typeof key !== 'string' || !Object.hasOwn(type.fields, key))) {
          problems.push({ stepId: step.id, path, message: `This object has no field ${String(key)}.` });
          break;
        }
        if ((type.kind === 'model' && key !== 'modelId') || !['object', 'array', 'model', 'unknown', 'union'].includes(type.kind) || (type.kind === 'array' && (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0))) {
          problems.push({ stepId: step.id, path, message: 'This value does not support the selected field or index.' });
          break;
        }
        type = workflowFieldType({ type, path: [key] });
      }
      break;
    }
    case 'not_empty': child({ value: value.value, expected: 'any', key: 'value', suffix: ['value'] });
      break;
    case 'arithmetic': case 'compare':
      child({ value: value.left, expected: 'number', key: 'left', suffix: ['left'] });
      child({ value: value.right, expected: 'number', key: 'right', suffix: ['right'] });
      break;
    case 'all': case 'any':
      value.items.forEach((value, index) => child({ value, expected: 'boolean', key: `items[${index}]`, suffix: ['items', index] }));
      break;
    case 'not': child({ value: value.value, expected: 'boolean', key: 'value', suffix: ['value'] });
      break;
    case 'equals': child({ value: value.left, expected: 'any', key: 'left', suffix: ['left'] });
      child({ value: value.right, expected: 'any', key: 'right', suffix: ['right'] });
      break;
    case 'conversation': value.messages.forEach((message, index) => message.parts.forEach((part, partIndex) => {
      switch (part.type) {
      case 'text': case 'reasoning':
      case 'tool_call': break;
      case 'tool_result': child({ value: part.content, expected: 'text', key: `messages[${index}].parts[${partIndex}]`, suffix: ['messages', index, 'parts', partIndex, 'content'] });
        break;
      case 'value': child({ value: part.value, expected: 'text', key: `messages[${index}].parts[${partIndex}]`, suffix: ['messages', index, 'parts', partIndex, 'value'] });
        break;
      default: {
        const exhaustive: never = part;
        throw new Error(String(exhaustive));
      }
      }
    }));
      break;
    case 'literal': case 'model': case 'step_output': case 'loop_item': case 'loop_index': case 'loop_state': break;
    default: {
      const exhaustive: never = value;
      throw new Error(String(exhaustive));
    }
    }
  }
  function visit({ steps, parent }: { steps: WorkflowStep[], parent: WorkflowTypeScope }): WorkflowTypeScope {
    const scope: WorkflowTypeScope = { outputs: new Map(parent.outputs), loops: new Map(parent.loops) };
    for (const step of steps) {
      inputs.set(step.id, { outputs: new Map(scope.outputs), loops: new Map(scope.loops) });
      const infer = ({ value }: { value: WorkflowValue }) => inferWorkflowValueType({ value, scope });
      const input = ({ value, expected, path, location }: { value: WorkflowValue, expected: WorkflowExpectedType, path: string, location: readonly (string | number)[] | undefined }) => check({ step, value, expected, scope: inputs.get(step.id)!, path, location });
      let outputs: Record<string, WorkflowDataType>;
      switch (step.type) {
      case 'value': input({ value: step.value, expected: 'any', path: 'value', location: ['value'] });
        outputs = { value: infer({ value: step.value }) };
        break;
      case 'model_selection': outputs = { value: { kind: 'array', item: { kind: 'model' } } };
        break;
      case 'parse_json': input({ value: step.source, expected: 'text', path: 'source', location: ['source'] });
        outputs = { value: unknownType };
        break;
      case 'audio_generation':
        input({ value: step.modelId, expected: 'text', path: 'modelId', location: ['modelId'] });
        input({ value: step.text, expected: 'text', path: 'text', location: ['text'] });
        if (step.reference !== undefined) {
          input({ value: step.reference, expected: 'binary', path: 'reference', location: ['reference'] });
        }
        for (const [key, value] of Object.entries(step.parameters)) {
          input({ value, expected: key === 'language' || key === 'audioBackend' ? 'text' : 'number', path: `parameters.${key}`, location: ['parameters', key] });
        }
        outputs = {
          audio: { kind: 'binary' },
          complete: { kind: 'boolean' },
          metadata: { kind: 'object', fields: { sampleRate: { kind: 'number' }, samples: { kind: 'number' }, frames: { kind: 'number' }, finishReason: { kind: 'text' }, pipeline: { kind: 'text' }, byteLength: { kind: 'number' } } },
        };
        break;
      case 'image_generation':
        input({ value: step.model, expected: 'json', path: 'model', location: ['model'] });
        input({ value: step.prompt, expected: 'text', path: 'prompt', location: ['prompt'] });
        if (step.imageInputs !== undefined) {
          if (step.imageInputs.initImage !== undefined) {
            input({ value: step.imageInputs.initImage, expected: 'binary', path: 'imageInputs.initImage', location: ['imageInputs', 'initImage'] });
          }
          input({ value: step.imageInputs.strength, expected: 'number', path: 'imageInputs.strength', location: ['imageInputs', 'strength'] });
          step.imageInputs.referenceImages.forEach((value, index) => input({ value, expected: 'binary', path: `imageInputs.referenceImages[${index}]`, location: ['imageInputs', 'referenceImages', index] }));
        }
        if (step.gpuBudgetMiB !== undefined) {
          input({ value: step.gpuBudgetMiB, expected: 'number', path: 'gpuBudgetMiB', location: ['gpuBudgetMiB'] });
        }
        for (const key of workflowImageParameterKeys) {
          input({ value: step.parameters[key], expected: workflowImageParameterType({ key }), path: `parameters.${key}`, location: ['parameters', key] });
        }
        outputs = {
          image: { kind: 'binary' },
          metadata: { kind: 'object', fields: { width: { kind: 'number' }, height: { kind: 'number' }, modelVersion: { kind: 'text' }, uniformOutput: { kind: 'boolean' }, byteLength: { kind: 'number' }, requestedSeed: { kind: 'text' }, profile: { kind: 'text' } } },
        };
        break;
      case 'tool_call': {
        input({ value: step.arguments, expected: 'json', path: 'arguments', location: ['arguments'] });
        const argumentsByName = workflowToolArgumentFields({ value: step.arguments });
        if (argumentsByName !== undefined) {
          for (const [key, expected] of Object.entries(workflowToolArgumentKinds({ name: step.tool.name }))) {
            const argument = Object.hasOwn(argumentsByName, key) ? argumentsByName[key] : undefined;
            if (argument !== undefined) {
              input({ value: argument, expected, path: `arguments.${key}`, location: bindingMaps.get(step.id)?.get(JSON.stringify(['arguments', 'properties', key]))?.location });
            }
          }
        }
        const fields: Record<string, WorkflowDataType> = { tool: { kind: 'text' }, status: { kind: 'text' } };
        const successful = ({ type }: { type: WorkflowDataType }): WorkflowDataType => {
          switch (step.onError) {
          case 'fail': return type;
          case 'continue': return unknownType;
          default: {
            const exhaustive: never = step.onError;
            throw new Error(String(exhaustive));
          }
          }
        };
        switch (step.onError) {
        case 'continue': fields.code = unknownType;
          break;
        case 'fail': break;
        default: {
          const exhaustive: never = step.onError;
          throw new Error(String(exhaustive));
        }
        }
        switch (step.tool.name) {
        case 'calculator': break;
        case 'wikipedia_search': fields.items = successful({ type: { kind: 'array', item: { kind: 'object', fields: { lang: { kind: 'text' }, pageId: { kind: 'number' }, title: { kind: 'text' } } } } });
          break;
        case 'wikipedia_get_page':
          fields.lang = successful({ type: { kind: 'text' } });
          fields.pageId = successful({ type: { kind: 'number' } });
          fields.title = successful({ type: { kind: 'text' } });
          break;
        case 'shell_execute':
          fields.exitCode = successful({ type: { kind: 'number' } });
          fields.truncated = { kind: 'boolean' };
          fields.truncatedStreams = { kind: 'array', item: { kind: 'text' } };
          break;
        default: {
          const exhaustive: never = step.tool;
          throw new Error(String(exhaustive));
        }
        }
        outputs = { text: { kind: 'text' }, ok: { kind: 'boolean' }, metadata: { kind: 'object', fields } };
        break;
      }
      case 'request_input': input({ value: step.prompt, expected: 'text', path: 'prompt', location: ['prompt'] });
        if (step.choices !== undefined) {
          input({ value: step.choices, expected: 'iterable', path: 'choices', location: ['choices'] });
        }
        switch (step.responseType) {
        case 'text': outputs = { value: { kind: 'text' } };
          break;
        case 'json': outputs = { value: unknownType };
          break;
        default: {
          const exhaustive: never = step.responseType;
          throw new Error(String(exhaustive));
        }
        }
        break;
      case 'text_generation':
        input({ value: step.target, expected: 'model', path: 'target', location: ['target'] });
        input({ value: step.conversation, expected: 'conversation', path: 'conversation', location: ['conversation'] });
        step.appendMessages.forEach((message, index) => message.parts.forEach((part, partIndex) => {
          switch (part.type) {
          case 'text': case 'reasoning':
          case 'tool_call': break;
          case 'tool_result': input({ value: part.content, expected: 'text', path: `appendMessages[${index}].parts[${partIndex}]`, location: ['appendMessages', index, 'parts', partIndex, 'content'] });
            break;
          case 'value': input({ value: part.value, expected: 'text', path: `appendMessages[${index}].parts[${partIndex}]`, location: ['appendMessages', index, 'parts', partIndex, 'value'] });
            break;
          default: {
            const exhaustive: never = part;
            throw new Error(String(exhaustive));
          }
          }
        }));
        outputs = { text: { kind: 'text' }, reasoning: { kind: 'text' }, conversation: { kind: 'conversation' }, metrics: unknownType };
        break;
      case 'read_file': input({ value: step.relativePath, expected: 'text', path: 'relativePath', location: ['relativePath'] });
        outputs = { content: { kind: 'binary' }, text: { kind: 'text' }, metadata: unknownType };
        break;
      case 'write_file': input({ value: step.relativePath, expected: 'text', path: 'relativePath', location: ['relativePath'] });
        input({ value: step.source, expected: fileSourceType({ format: step.format }), path: 'source', location: ['source'] });
        outputs = { file: unknownType };
        break;
      case 'repeat': case 'for_each': {
        let item: WorkflowDataType | undefined;
        switch (step.type) {
        case 'repeat': input({ value: step.count, expected: 'number', path: 'count', location: ['count'] });
          item = undefined;
          break;
        case 'for_each': input({ value: step.source, expected: 'iterable', path: 'source', location: ['source'] });
          item = workflowItemType({ type: infer({ value: step.source }) });
          break;
        default: {
          const exhaustive: never = step;
          throw new Error(String(exhaustive));
        }
        }
        const state = Object.fromEntries(Object.entries(step.state).map(([key, value]) => {
          input({ value: value.initial, expected: 'any', path: `state.${key}.initial`, location: ['state', key, 'initial'] });
          // A changing state has no declared invariant. Do not promise the initial
          // type on every iteration; its next expression may produce another type.
          return [key, value.next.type === 'loop_state' && value.next.stepId === step.id && value.next.key === key ? infer({ value: value.initial }) : unknownType];
        }));
        const loops = new Map(scope.loops);
        loops.set(step.id, { step, item, state });
        const body = visit({ steps: step.body.steps, parent: { outputs: scope.outputs, loops } });
        bodies.set(step.id, body);
        for (const [key, value] of Object.entries(step.state)) {
          check({ step, value: value.next, expected: 'any', scope: body, path: `state.${key}.next`, location: ['state', key, 'next'] });
        }
        outputs = { state: { kind: 'object', fields: state }, iterations: { kind: 'number' }, stoppedBy: { kind: 'text' } };
        if (step.stopWhen !== undefined) {
          check({ step, value: step.stopWhen, expected: 'boolean', scope: body, path: 'stopWhen', location: ['stopWhen'] });
        }
        if (step.emit !== undefined) {
          check({ step, value: step.emit, expected: 'any', scope: body, path: 'emit', location: ['emit'] });
          outputs.items = { kind: 'sequence', item: inferWorkflowValueType({ value: step.emit, scope: body }) };
        }
        break;
      }
      case 'if': {
        input({ value: step.condition, expected: 'boolean', path: 'condition', location: ['condition'] });
        const left = visit({ steps: step.then.steps, parent: scope }), right = visit({ steps: step.else.steps, parent: scope });
        branches.set(step.id, { then: left, else: right });
        outputs = Object.fromEntries(Object.entries(step.then.outputs).map(([key, value]) => {
          check({ step, value, expected: 'any', scope: left, path: `then.outputs.${key}`, location: ['then', 'outputs', key] });
          const other = Object.hasOwn(step.else.outputs, key) ? step.else.outputs[key] : undefined;
          return [key, joinWorkflowTypes({ types: [inferWorkflowValueType({ value, scope: left }), other ? inferWorkflowValueType({ value: other, scope: right }) : unknownType] })];
        }));
        for (const [key, value] of Object.entries(step.else.outputs)) {
          check({ step, value, expected: 'any', scope: right, path: `else.outputs.${key}`, location: ['else', 'outputs', key] });
        }
        break;
      }
      default: {
        const exhaustive: never = step;
        throw new Error(String(exhaustive));
      }
      }
      outputTypes.set(step.id, outputs);
      scope.outputs.set(step.id, { step, outputs });
    }
    return scope;
  }
  visit({ steps: definition.steps, parent: emptyWorkflowTypeScope() });
  return { inputs, bodies, branches, problems, valueBindings: new Map([...bindingMaps].map(([id, bindings]) => [id, [...bindings.values()]])), outputTypes };
}

export const TEST_ONLY = {
};
