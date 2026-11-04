import type { WorkflowDefinition, WorkflowStep, WorkflowValue, WorkflowMessage } from '@/01-models/workflow';
import type { WorkflowStepId, VolumeId } from '@/01-models/ids';
import type { WorkflowOutputStore } from './output-store';
import { parseWorkflowJson } from '@/00-storage/service/workflow-json';
import { validateWorkflowRange, workflowRangeItems } from './range';
import { validateJsonAssignments, replaceJsonValue } from './json-composition';
import { validateWorkflow } from './definition';
import { freezeWorkflowData, freezeRuntimeValue, requireModelValue, requireConversationValue, textChunks, retainValue, releaseValue, releaseValues, readText, spoolText, materializeJson, serializeValue, writeText, sequenceValues, safeRelativePath, WORKFLOW_INPUT_LIMIT, type RuntimeValue, type RuntimeMessage } from './values';

export type WorkflowOutputs = Record<string, RuntimeValue>;
export type WorkflowGenerationInput = {
  step: Extract<WorkflowStep, { type: 'text_generation' }>, target: Extract<RuntimeValue, { type: 'model' }>,
  conversation: RuntimeMessage[], signal: AbortSignal, store: WorkflowOutputStore,
};
export type WorkflowRuntimeServices = {
  generate: ({ input }: { input: WorkflowGenerationInput }) => Promise<WorkflowOutputs>,
  requestInput: ({ step, prompt, signal }: { step: Extract<WorkflowStep, { type: 'request_input' }>, prompt: string, signal: AbortSignal }) => Promise<string>,
  readFile: ({ volumeId, path, signal, store }: { volumeId: VolumeId, path: string[], signal: AbortSignal, store: WorkflowOutputStore }) => Promise<WorkflowOutputs>,
  writeFile: ({ step, path, source, signal }: { step: Extract<WorkflowStep, { type: 'write_file' }>, path: string[], source: RuntimeValue, signal: AbortSignal }) => Promise<WorkflowOutputs>,
  onStep: ({ step, phase, trace, outputs }: { step: WorkflowStep, phase: 'running' | 'completed', trace: number[], outputs: WorkflowOutputs | undefined }) => Promise<void>,
};
export type WorkflowRunResult = {
  status: 'completed' | 'failed' | 'cancelled', error: unknown,
  outputs: ReadonlyMap<WorkflowStepId, WorkflowOutputs>, release: () => Promise<void>,
};

type Scope = { outputs: Map<WorkflowStepId, WorkflowOutputs>, parent: Scope | undefined };
type LoopFrame = { index: number, item: RuntimeValue | undefined, state: Record<string, RuntimeValue> };

/** Sequence order is authoritative. Internal spooling never executes a later user-file side effect early. */
export async function executeWorkflow({ definition, store, signal, services }: {
  definition: WorkflowDefinition, store: WorkflowOutputStore, signal: AbortSignal, services: WorkflowRuntimeServices,
}): Promise<WorkflowRunResult> {
  const snapshot = structuredClone(definition);
  freezeWorkflowData({ value: snapshot });
  const issues = validateWorkflow({ definition: snapshot });
  if (issues.length) {
    throw new Error(issues.map(issue => `${issue.path}: ${issue.message}`).join('\n'));
  }
  const root: Scope = { outputs: new Map(), parent: undefined };
  let activations = 0, evaluations = 0;
  const loops = new Map<WorkflowStepId, LoopFrame>();
  const guard = (): void => {
    signal.throwIfAborted();
    if (++evaluations > 100000) {
      throw new Error('Workflow expression limit exceeded.');
    }
  };
  const clear = async ({ scope }: { scope: Scope }): Promise<void> => {
    const values = [...scope.outputs.values()].flatMap(Object.values);
    await releaseValues({ values });
    scope.outputs.clear();
  };
  const find = ({ scope, stepId, output }: { scope: Scope, stepId: WorkflowStepId, output: string }): RuntimeValue => {
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      const outputs = current.outputs.get(stepId);
      if (outputs && Object.hasOwn(outputs, output)) {
        return retainValue({ value: outputs[output]! });
      }
    }
    throw new Error(`Output is unavailable: ${output}`);
  };
  const record = async ({ properties, scope }: { properties: Record<string, WorkflowValue>, scope: Scope }): Promise<Record<string, RuntimeValue>> => {
    const entries: [string, RuntimeValue][] = [];
    try {
      for (const [key, value] of Object.entries(properties)) {
        entries.push([key, await evaluate({ value, scope })]);
      }
      return Object.fromEntries(entries);
    } catch (error) {
      await releaseValues({ values: entries.map(([, value]) => value) });
      throw error;
    }
  };
  const messages = async ({ input, scope }: { input: WorkflowMessage[], scope: Scope }): Promise<RuntimeMessage[]> => {
    const result: RuntimeMessage[] = [];
    try {
      for (const message of input) {
        const runtime: RuntimeMessage = { role: message.role, parts: [] };
        result.push(runtime);
        for (const part of message.parts) {
          switch (part.type) {
          case 'text': runtime.parts.push({ type: 'json', value: part.text });
            break;
          case 'value': runtime.parts.push(await evaluate({ value: part.value, scope }));
            break;
          default: {
            const exhaustive: never = part;
            throw new Error(`Unknown message part: ${exhaustive}`);
          }
          }
        }
      }
      return result;
    } catch (error) {
      await releaseValues({ values: result.flatMap(message => message.parts) });
      throw error;
    }
  };
  const evaluate = async ({ value, scope }: { value: WorkflowValue, scope: Scope }): Promise<RuntimeValue> => {
    guard();
    switch (value.type) {
    case 'literal': return { type: 'json', value: value.value };
    case 'model': return { type: 'model', endpoint: value.endpoint, modelId: value.modelId };
    case 'step_output': return find({ scope, stepId: value.stepId, output: value.output });
    case 'loop_item': {
      const item = loops.get(value.stepId)?.item;
      if (!item) {
        throw new Error('Loop item is unavailable.');
      }
      return retainValue({ value: item });
    }
    case 'loop_index': {
      const loop = loops.get(value.stepId);
      if (!loop) {
        throw new Error('Loop index is unavailable.');
      }
      return { type: 'json', value: loop.index };
    }
    case 'loop_state': {
      const loop = loops.get(value.stepId);
      if (!loop || !Object.hasOwn(loop.state, value.key)) {
        throw new Error('Loop state is unavailable.');
      }
      return retainValue({ value: loop.state[value.key]! });
    }
    case 'json_compose': {
      validateJsonAssignments({ base: value.base, paths: value.assignments.map(item => item.path) });
      let json = value.base;
      for (const assignment of value.assignments) {
        const replacement = await evaluate({ value: assignment.value, scope });
        try {
          json = replaceJsonValue({ base: json, path: assignment.path, value: await materializeJson({ value: replacement, signal }) });
          // Limit total size as well as each substituted value.
          json = parseWorkflowJson({ text: JSON.stringify(json) });
        } finally {
          await releaseValue({ value: replacement });
        }
      }
      return { type: 'json', value: json };
    }
    case 'range': {
      const number = async ({ expression }: { expression: WorkflowValue }): Promise<number> => {
        const result = await evaluate({ value: expression, scope });
        try {
          if (result.type !== 'json' || typeof result.value !== 'number') {
            throw new Error('A number range requires numeric inputs.');
          }
          return result.value;
        } finally {
          await releaseValue({ value: result });
        }
      };
      const range = { start: await number({ expression: value.start }), end: value.end === undefined ? undefined : await number({ expression: value.end }), step: await number({ expression: value.step }) };
      validateWorkflowRange({ range });
      return { type: 'range', ...range };
    }
    case 'object': return { type: 'object', properties: await record({ properties: value.properties, scope }) };
    case 'conversation': return { type: 'conversation', messages: await messages({ input: value.messages, scope }) };
    case 'array': {
      const items: RuntimeValue[] = [];
      try {
        for (const item of value.items) {
          items.push(await evaluate({ value: item, scope }));
        }
        return { type: 'array', items };
      } catch (error) {
        await releaseValues({ values: items });
        throw error;
      }
    }
    case 'concat': {
      const parts = value.items;
      async function* chunks(): AsyncGenerator<string> {
        for (const part of parts) {
          const item = await evaluate({ value: part, scope });
          try {
            yield* textChunks({ value: item, signal });
          } finally {
            await releaseValue({ value: item });
          }
        }
      }
      return spoolText({ store, signal, chunks: chunks() });
    }
    case 'path': {
      const segments: string[] = [];
      for (const part of value.items) {
        const item = await evaluate({ value: part, scope });
        try {
          const text = await readText({ value: item, maxBytes: 1024, signal });
          if (text.includes('/')) {
            throw new Error('Each structured path item must be one segment.');
          }
          segments.push(text);
        } finally {
          await releaseValue({ value: item });
        }
      }
      const text = segments.join('/');
      safeRelativePath({ path: text });
      return { type: 'json', value: text };
    }
    case 'equals': {
      const left = await evaluate({ value: value.left, scope });
      try {
        const right = await evaluate({ value: value.right, scope });
        try {
          const a = await materializeJson({ value: left, signal }), b = await materializeJson({ value: right, signal });
          if (typeof a === 'object' || typeof b === 'object') {
            if (a !== null || b !== null) {
              throw new Error('Equality accepts scalar values, not objects or arrays.');
            }
          }
          return { type: 'json', value: a === b };
        } finally {
          await releaseValue({ value: right });
        }
      } finally {
        await releaseValue({ value: left });
      }
    }
    case 'get': {
      let current = await evaluate({ value: value.value, scope });
      try {
        for (const key of value.path) {
          let next: RuntimeValue;
          if (current.type === 'model' && key === 'modelId') {
            // Comparison labels may use the public ID without exporting endpoint
            // headers or turning the whole model capability into ordinary JSON.
            next = { type: 'json', value: current.modelId };
          } else if (current.type === 'object' && typeof key === 'string' && Object.hasOwn(current.properties, key)) {
            next = retainValue({ value: current.properties[key]! });
          } else if (current.type === 'array' && typeof key === 'number' && current.items[key]) {
            next = retainValue({ value: current.items[key]! });
          } else if (current.type === 'json' && current.value !== null && typeof current.value === 'object' && Object.hasOwn(current.value, key)) {
            const object = current.value;
            const child = Array.isArray(object) ? (typeof key === 'number' ? object[key] : undefined) : object[String(key)];
            if (child === undefined) {
              throw new Error('Field or array index is missing.');
            }
            next = { type: 'json', value: child };
          } else {
            throw new Error(`Field is unavailable: ${key}`);
          }
          await releaseValue({ value: current });
          current = next;
        }
        return retainValue({ value: current });
      } finally {
        await releaseValue({ value: current });
      }
    }
    case 'filename': case 'format_number': case 'not_empty': {
      const item = await evaluate({ value: value.value, scope });
      try {
        switch (value.type) {
        case 'filename': {
          const original = await readText({ value: item, maxBytes: 4096, signal });
          // eslint-disable-next-line no-control-regex -- A filename must not contain control characters or path separators.
          const cleaned = original.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/gu, '_').replace(/[. ]+$/u, '').slice(0, 120);
          return { type: 'json', value: !cleaned || cleaned === '.' || cleaned === '..' || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(cleaned) ? `_${cleaned || 'file'}` : cleaned };
        }
        case 'format_number': {
          if (item.type !== 'json' || typeof item.value !== 'number' || !Number.isSafeInteger(item.value) || item.value < 0) {
            throw new Error('Number formatting needs a nonnegative safe integer.');
          }
          return { type: 'json', value: String(item.value).padStart(value.minDigits, '0') };
        }
        case 'not_empty': {
          switch (item.type) {
          case 'text': case 'binary': case 'sequence': return { type: 'json', value: item.output.byteLength > 0 };
          case 'array': return { type: 'json', value: item.items.length > 0 };
          case 'object': return { type: 'json', value: Object.keys(item.properties).length > 0 };
          case 'conversation': return { type: 'json', value: item.messages.length > 0 };
          case 'range': return { type: 'json', value: !workflowRangeItems({ range: item }).next().done };
          case 'model': throw new Error('A model is not a collection.');
          case 'json': {
            const json = item.value;
            return { type: 'json', value: json !== null && (typeof json === 'string' || Array.isArray(json) ? json.length > 0 : typeof json === 'object' ? Object.keys(json).length > 0 : true) };
          }
          default: {
            const exhaustive: never = item;
            throw new Error(`Unknown value: ${exhaustive}`);
          }
          }
        }
        default: {
          const exhaustive: never = value;
          throw new Error(`Unknown expression: ${exhaustive}`);
        }
        }
      } finally {
        await releaseValue({ value: item });
      }
    }
    default: {
      const exhaustive: never = value;
      throw new Error(`Unknown expression: ${exhaustive}`);
    }
    }
  };
  async function* items({ source }: { source: RuntimeValue }): AsyncGenerator<RuntimeValue> {
    switch (source.type) {
    case 'array': for (const value of source.items) {
      yield retainValue({ value });
    }
      return;
    case 'json':
      if (!Array.isArray(source.value)) {
        throw new Error('ForEach expects an array.');
      }
      for (const value of source.value) {
        yield { type: 'json', value };
      }
      return;
    case 'range':
      for (const value of workflowRangeItems({ range: source })) {
        signal.throwIfAborted();
        yield { type: 'json', value };
      }
      return;
    case 'sequence': break;
    case 'text': case 'binary': case 'model': case 'object': case 'conversation': throw new Error('ForEach expects an array or a sequence.');
    default: {
      const exhaustive: never = source;
      throw new Error(`Unknown value: ${exhaustive}`);
    }
    }
    for await (const value of sequenceValues({ output: source.output, signal })) {
      yield { type: 'json', value };
    }
  }
  const executeStep = async ({ step, scope, trace }: { step: WorkflowStep, scope: Scope, trace: number[] }): Promise<WorkflowOutputs> => {
    guard();
    switch (step.type) {
    case 'value': return { value: await evaluate({ value: step.value, scope }) };
    case 'model_selection': return { value: { type: 'array', items: step.targets.map(target => ({ type: 'model', ...target })) } };
    case 'parse_json': {
      const source = await evaluate({ value: step.source, scope });
      try {
        return { value: { type: 'json', value: parseWorkflowJson({ text: await readText({ value: source, maxBytes: WORKFLOW_INPUT_LIMIT, signal }) }) } };
      } finally {
        await releaseValue({ value: source });
      }
    }
    case 'request_input': {
      const prompt = await evaluate({ value: step.prompt, scope });
      try {
        const text = await services.requestInput({ step, prompt: await readText({ value: prompt, maxBytes: 16384, signal }), signal });
        signal.throwIfAborted();
        if (new TextEncoder().encode(text).byteLength > WORKFLOW_INPUT_LIMIT) {
          throw new Error('Interactive response exceeds the input limit.');
        }
        switch (step.responseType) {
        case 'json': return { value: { type: 'json', value: parseWorkflowJson({ text }) } };
        case 'text': return { value: { type: 'json', value: text } };
        default: {
          const exhaustive: never = step.responseType;
          throw new Error(`Unknown response type: ${exhaustive}`);
        }
        }
      } finally {
        await releaseValue({ value: prompt });
      }
    }
    case 'text_generation': {
      const target = await evaluate({ value: step.target, scope });
      try {
        const model = await requireModelValue({ value: target, signal });
        const conversation = await evaluate({ value: step.conversation, scope });
        try {
          const history = requireConversationValue({ value: conversation });
          const extra = await messages({ input: step.appendMessages, scope });
          try {
            return await services.generate({ input: { step, target: model, conversation: [...history.messages, ...extra], signal, store } });
          } finally {
            await releaseValues({ values: extra.flatMap(message => message.parts) });
          }
        } finally {
          await releaseValue({ value: conversation });
        }
      } finally {
        await releaseValue({ value: target });
      }
    }
    case 'if': {
      const condition = await evaluate({ value: step.condition, scope });
      try {
        if (condition.type !== 'json' || typeof condition.value !== 'boolean') {
          throw new Error('If requires a boolean condition.');
        }
        const branch = condition.value ? step.then : step.else;
        const nested: Scope = { outputs: new Map(), parent: scope };
        try {
          await block({ steps: branch.steps, scope: nested, trace });
          return await record({ properties: branch.outputs, scope: nested });
        } finally {
          await clear({ scope: nested });
        }
      } finally {
        await releaseValue({ value: condition });
      }
    }
    case 'repeat': case 'for_each': {
      let state = await record({ properties: Object.fromEntries(Object.entries(step.state).map(([key, value]) => [key, value.initial])), scope });
      let source: RuntimeValue | undefined;
      let writer: Awaited<ReturnType<WorkflowOutputStore['createWriter']>> | undefined;
      try {
        let iterable: AsyncIterable<RuntimeValue>, includeItem: boolean;
        switch (step.type) {
        case 'repeat':
          source = await evaluate({ value: step.count, scope });
          if (source.type !== 'json' || typeof source.value !== 'number' || !Number.isSafeInteger(source.value) || source.value < 0 || source.value > 1000) {
            throw new Error('Repeat count must be an integer between 0 and 1000.');
          }
          iterable = items({ source: { type: 'json', value: Array.from({ length: source.value }, (_, index) => index) } });
          includeItem = false;
          break;
        case 'for_each':
          source = await evaluate({ value: step.source, scope });
          iterable = items({ source });
          includeItem = true;
          break;
        default: {
          const exhaustive: never = step;
          throw new Error(`Unknown loop: ${exhaustive}`);
        }
        }
        if (step.emit !== undefined) {
          writer = await store.createWriter({ signal });
        }
        let index = 0;
        for await (const item of iterable) {
          const nested: Scope = { outputs: new Map(), parent: scope };
          let next: Record<string, RuntimeValue> | undefined;
          try {
            if (index >= 1000) {
              throw new Error('ForEach exceeds 1000 iterations.');
            }
            loops.set(step.id, { index, item: includeItem ? item : undefined, state });
            await block({ steps: step.body.steps, scope: nested, trace: [...trace, index] });
            next = await record({ properties: Object.fromEntries(Object.entries(step.state).map(([key, value]) => [key, value.next])), scope: nested });
            if (step.emit !== undefined && writer) {
              const emitted = await evaluate({ value: step.emit, scope: nested });
              try {
                let bytes = 0;
                for await (const chunk of serializeValue({ value: emitted, signal })) {
                  bytes += new TextEncoder().encode(chunk).byteLength;
                  if (bytes > WORKFLOW_INPUT_LIMIT) {
                    throw new Error('Collected item exceeds the JSON input limit; save large files inside the loop instead.');
                  }
                  await writeText({ writer, text: chunk });
                }
                await writeText({ writer, text: '\n' });
              } finally {
                await releaseValue({ value: emitted });
              }
            }
            await releaseValues({ values: Object.values(state) });
            state = next;
            next = undefined;
            index++;
          } finally {
            loops.delete(step.id);
            if (next) {
              await releaseValues({ values: Object.values(next) });
            }
            await releaseValue({ value: item });
            await clear({ scope: nested });
          }
        }
        const result: WorkflowOutputs = { state: { type: 'object', properties: state } };
        if (writer) {
          result.items = { type: 'sequence', output: await writer.seal() };
        }
        state = {};
        return result;
      } catch (error) {
        await writer?.abort({ reason: error });
        throw error;
      } finally {
        if (source) {
          await releaseValue({ value: source });
        }
        await releaseValues({ values: Object.values(state) });
      }
    }
    case 'read_file': case 'write_file': {
      const relativePath = await evaluate({ value: step.relativePath, scope });
      try {
        const path = safeRelativePath({ path: await readText({ value: relativePath, maxBytes: 4096, signal }) });
        switch (step.type) {
        case 'read_file': return await services.readFile({ volumeId: step.volumeId, path, store, signal });
        case 'write_file': break;
        default: {
          const exhaustive: never = step;
          throw new Error(`Unknown file step: ${exhaustive}`);
        }
        }
        const source = await evaluate({ value: step.source, scope });
        try {
          return await services.writeFile({ step, path, source, signal });
        } finally {
          await releaseValue({ value: source });
        }
      } finally {
        await releaseValue({ value: relativePath });
      }
    }
    default: {
      const exhaustive: never = step;
      throw new Error(`Unknown step: ${exhaustive}`);
    }
    }
  };
  const block = async ({ steps, scope, trace }: { steps: WorkflowStep[], scope: Scope, trace: number[] }): Promise<void> => {
    for (const step of steps) {
      signal.throwIfAborted();
      if (++activations > 5000) {
        throw new Error('Workflow exceeds 5000 step activations.');
      }
      await services.onStep({ step, phase: 'running', trace, outputs: undefined });
      const outputs = await executeStep({ step, scope, trace });
      Object.values(outputs).forEach(value => freezeRuntimeValue({ value }));
      Object.freeze(outputs);
      scope.outputs.set(step.id, outputs);
      await services.onStep({ step, phase: 'completed', trace, outputs });
    }
  };
  let status: WorkflowRunResult['status'] = 'completed', error: unknown;
  try {
    await block({ steps: snapshot.steps, scope: root, trace: [] });
  } catch (reason) {
    status = signal.aborted ? 'cancelled' : 'failed';
    error = reason;
  }
  return { status, error, outputs: root.outputs, release: () => clear({ scope: root }) };
}

export const TEST_ONLY = {
};
