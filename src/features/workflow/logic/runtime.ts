import { workflowChoicesSchema } from './input-choices';
import { resolveWorkflowToolRequest, type WorkflowToolRequest } from './tool-input';
import { resolveWorkflowImageRequest, type WorkflowImageRequest } from './image-input';
import { resolveWorkflowAudioRequest, type WorkflowAudioRequest } from './audio-input';
import type { WorkflowDefinition, WorkflowStep, WorkflowValue, WorkflowMessage } from '@/01-models/workflow';
import type { WorkflowStepId, VolumeId } from '@/01-models/ids';
import type { WorkflowOutputStore } from './output-store';
import { parseWorkflowJson } from '@/00-storage/service/workflow-json';
import { validateWorkflowRange, workflowRangeItems } from './range';
import { validateJsonAssignments, replaceJsonValue } from './json-composition';
import { createWorkflowExecutionControl, resolveWorkflowExecutionLimits } from './execution-control';
import { calculateWorkflowNumber, compareWorkflowNumbers } from './operators';
import { validateWorkflow } from './definition';
import { workflowValueOrigin, mergeWorkflowOrigins, workflowFieldOrigin, replaceWorkflowOrigin, workflowTargetSources, workflowOriginSources, type WorkflowValueProvenance, type WorkflowValueSource } from './provenance';
import { runtimeMessageValues, freezeWorkflowData, freezeRuntimeValue, requireModelValue, requireConversationValue, textChunks, retainValue, releaseValue, releaseValues, readText, spoolText, materializeJson, serializeValue, writeText, sequenceValues, safeRelativePath, WORKFLOW_INPUT_LIMIT, type RuntimeValue, type RuntimeMessage } from './values';

export type WorkflowOutputs = Record<string, RuntimeValue>;
export type WorkflowGenerationInput = {
  step: Extract<WorkflowStep, { type: 'text_generation' }>, target: Extract<RuntimeValue, { type: 'model' }>,
  conversation: RuntimeMessage[], signal: AbortSignal, store: WorkflowOutputStore,
  targetSources: readonly WorkflowValueSource[],
};
export type WorkflowAudioGenerationInput = {
  step: Extract<WorkflowStep, { type: 'audio_generation' }>,
  request: WorkflowAudioRequest,
  reference: Extract<RuntimeValue, { type: 'binary' }> | undefined,
  onLimit: 'error' | 'keep',
  targetSources: readonly WorkflowValueSource[],
  signal: AbortSignal,
  store: WorkflowOutputStore,
};
export type WorkflowImageGenerationInput = {
  step: Extract<WorkflowStep, { type: 'image_generation' }>,
  request: WorkflowImageRequest,
  images?: { initImage: Extract<RuntimeValue, { type: 'binary' }> | undefined, referenceImages: Extract<RuntimeValue, { type: 'binary' }>[], strength: number },
  targetSources: readonly WorkflowValueSource[],
  signal: AbortSignal,
  store: WorkflowOutputStore,
};
export type WorkflowToolInput = {
  step: Extract<WorkflowStep, { type: 'tool_call' }>, request: WorkflowToolRequest,
  signal: AbortSignal, store: WorkflowOutputStore,
};
export type WorkflowRuntimeServices = {
  callTool: ({ input }: { input: WorkflowToolInput }) => Promise<WorkflowOutputs>,
  generateImage: ({ input }: { input: WorkflowImageGenerationInput }) => Promise<WorkflowOutputs>,
  generateAudio: ({ input }: { input: WorkflowAudioGenerationInput }) => Promise<WorkflowOutputs>,
  generate: ({ input }: { input: WorkflowGenerationInput }) => Promise<WorkflowOutputs>,
  requestInput: ({ step, prompt, choices, signal }: { step: Extract<WorkflowStep, { type: 'request_input' }>, prompt: string, choices?: string[], signal: AbortSignal }) => Promise<string>,
  readFile: ({ volumeId, path, signal, store }: { volumeId: VolumeId, path: string[], signal: AbortSignal, store: WorkflowOutputStore }) => Promise<WorkflowOutputs>,
  writeFile: ({ step, path, source, signal }: { step: Extract<WorkflowStep, { type: 'write_file' }>, path: string[], source: RuntimeValue, signal: AbortSignal }) => Promise<WorkflowOutputs>,
  onStep: ({ step, phase, trace, outputs }: { step: WorkflowStep, phase: 'running' | 'completed', trace: number[], outputs: WorkflowOutputs | undefined }) => Promise<void>,
};
export type WorkflowRunResult = {
  status: 'completed' | 'failed' | 'cancelled', error: unknown,
  outputs: ReadonlyMap<WorkflowStepId, WorkflowOutputs>, release: () => Promise<void>,
};

type Scope = { outputs: Map<WorkflowStepId, WorkflowOutputs>, parent: Scope | undefined };
type LoopFrame = { index: number, item: RuntimeValue | undefined, state: Record<string, RuntimeValue>, origin: WorkflowValueProvenance };

/** Sequence order is authoritative. Internal spooling never executes a later user-file side effect early. */
export async function executeWorkflow({ definition, store, signal: parentSignal, services }: {
  definition: WorkflowDefinition, store: WorkflowOutputStore, signal: AbortSignal, services: WorkflowRuntimeServices,
}): Promise<WorkflowRunResult> {
  const snapshot = structuredClone(definition);
  freezeWorkflowData({ value: snapshot });
  const issues = validateWorkflow({ definition: snapshot });
  if (issues.length) {
    throw new Error(issues.map(issue => `${issue.path}: ${issue.message}`).join('\n'));
  }
  const control = createWorkflowExecutionControl({ limits: resolveWorkflowExecutionLimits({ limits: snapshot.executionLimits }), signal: parentSignal });
  const { signal } = control;
  const root: Scope = { outputs: new Map(), parent: undefined };
  const loops = new Map<WorkflowStepId, LoopFrame>();
  const guard = control.evaluate;
  // Keep evidence outside RuntimeValue: imports, history and exports cannot forge it.
  const origins = new WeakMap<RuntimeValue, WorkflowValueProvenance>();
  const origin = ({ value }: { value: RuntimeValue }): WorkflowValueProvenance => origins.get(value) ?? workflowValueOrigin({ source: 'unknown' });
  const mark = ({ value, provenance }: { value: RuntimeValue, provenance: WorkflowValueProvenance }): RuntimeValue => {
    // A projected JSON/model value may share its original identity with a parent.
    // Give this ownership path its own evidence without changing that parent.
    const marked = { ...value };
    origins.set(marked, provenance);
    return marked;
  };
  const retain = ({ value }: { value: RuntimeValue }): RuntimeValue => mark({ value: retainValue({ value }), provenance: origin({ value }) });
  const propertiesOrigin = ({ properties }: { properties: Record<string, RuntimeValue> }): WorkflowValueProvenance => ({
    sources: ['definition'],
    properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, origin({ value })])),
  });
  const externalOutputs = ({ outputs, source }: { outputs: WorkflowOutputs, source: WorkflowValueSource }): WorkflowOutputs => Object.fromEntries(
    Object.entries(outputs).map(([key, value]) => [key, mark({ value, provenance: workflowValueOrigin({ source }) })]),
  );
  const clear = async ({ scope }: { scope: Scope }): Promise<void> => {
    const values = [...scope.outputs.values()].flatMap(Object.values);
    await releaseValues({ values });
    scope.outputs.clear();
  };
  const find = ({ scope, stepId, output }: { scope: Scope, stepId: WorkflowStepId, output: string }): RuntimeValue => {
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      const outputs = current.outputs.get(stepId);
      if (outputs && Object.hasOwn(outputs, output)) {
        return retain({ value: outputs[output]! });
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
          case 'text': runtime.parts.push(mark({ value: { type: 'json', value: part.text }, provenance: workflowValueOrigin({ source: 'definition' }) }));
            break;
          case 'reasoning': runtime.parts.push({ type: 'reasoning', content: mark({ value: { type: 'json', value: part.text }, provenance: workflowValueOrigin({ source: 'definition' }) }) });
            break;
          case 'value': runtime.parts.push(await evaluate({ value: part.value, scope }));
            break;
          case 'tool_call': runtime.parts.push({ ...part });
            break;
          case 'tool_result': runtime.parts.push({ ...part, content: await evaluate({ value: part.content, scope }) });
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
      await releaseValues({ values: runtimeMessageValues({ messages: result }) });
      throw error;
    }
  };
  const evaluate = async ({ value, scope }: { value: WorkflowValue, scope: Scope }): Promise<RuntimeValue> => {
    guard();
    await control.yieldToHost();
    const dependencies: WorkflowValueProvenance[] = [];
    const resolve = async ({ value, scope }: { value: WorkflowValue, scope: Scope }): Promise<RuntimeValue> => {
      const result = await evaluate({ value, scope });
      dependencies.push(origin({ value: result }));
      return result;
    };
    const expression = async (): Promise<RuntimeValue> => {
      switch (value.type) {
      case 'arithmetic': case 'compare': {
        const number = async ({ expression }: { expression: WorkflowValue }): Promise<number> => {
          const resolved = await resolve({ value: expression, scope });
          try {
            if (resolved.type !== 'json' || typeof resolved.value !== 'number') {
              throw new Error('Numeric operators require numbers without implicit conversion.');
            }
            return resolved.value;
          } finally {
            await releaseValue({ value: resolved });
          }
        };
        const left = await number({ expression: value.left }), right = await number({ expression: value.right });
        switch (value.type) {
        case 'arithmetic': return { type: 'json', value: calculateWorkflowNumber({ operator: value.operator, left, right }) };
        case 'compare': return { type: 'json', value: compareWorkflowNumbers({ operator: value.operator, left, right }) };
        default: {
          const exhaustive: never = value;
          throw new Error(String(exhaustive));
        }
        }
      }
      case 'not': {
        const resolved = await resolve({ value: value.value, scope });
        try {
          if (resolved.type !== 'json' || typeof resolved.value !== 'boolean') {
            throw new Error('Logical negation requires a boolean.');
          }
          return { type: 'json', value: !resolved.value };
        } finally {
          await releaseValue({ value: resolved });
        }
      }
      case 'all': case 'any': {
      // Short-circuiting is part of the expression contract: an unused reference
      // is not read and an unused conversion cannot fail at runtime.
        for (const item of value.items) {
          const resolved = await resolve({ value: item, scope });
          try {
            if (resolved.type !== 'json' || typeof resolved.value !== 'boolean') {
              throw new Error('Logical operations require booleans.');
            }
            if ((value.type === 'all' && !resolved.value) || (value.type === 'any' && resolved.value)) {
              return { type: 'json', value: resolved.value };
            }
          } finally {
            await releaseValue({ value: resolved });
          }
        }
        return { type: 'json', value: value.type === 'all' };
      }
      case 'literal': return { type: 'json', value: value.value };
      case 'model': return { type: 'model', endpoint: value.endpoint, modelId: value.modelId };
      case 'step_output': return find({ scope, stepId: value.stepId, output: value.output });
      case 'loop_item': {
        const item = loops.get(value.stepId)?.item;
        if (!item) {
          throw new Error('Loop item is unavailable.');
        }
        return retain({ value: item });
      }
      case 'loop_index': {
        const loop = loops.get(value.stepId);
        if (!loop) {
          throw new Error('Loop index is unavailable.');
        }
        return mark({ value: { type: 'json', value: loop.index }, provenance: loop.origin });
      }
      case 'loop_state': {
        const loop = loops.get(value.stepId);
        if (!loop || !Object.hasOwn(loop.state, value.key)) {
          throw new Error('Loop state is unavailable.');
        }
        return retain({ value: loop.state[value.key]! });
      }
      case 'json_compose': {
        validateJsonAssignments({ base: value.base, paths: value.assignments.map(item => item.path) });
        let json = value.base;
        let provenance = workflowValueOrigin({ source: 'definition' });
        for (const assignment of value.assignments) {
          const replacement = await resolve({ value: assignment.value, scope });
          try {
            json = replaceJsonValue({ base: json, path: assignment.path, value: await materializeJson({ value: replacement, signal }) });
            provenance = replaceWorkflowOrigin({ origin: provenance, path: assignment.path, replacement: origin({ value: replacement }) });
            // Limit total size as well as each substituted value.
            json = parseWorkflowJson({ text: JSON.stringify(json) });
          } finally {
            await releaseValue({ value: replacement });
          }
        }
        return mark({ value: { type: 'json', value: json }, provenance });
      }
      case 'range': {
        const number = async ({ expression }: { expression: WorkflowValue }): Promise<number> => {
          const result = await resolve({ value: expression, scope });
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
      case 'object': {
        const properties = await record({ properties: value.properties, scope });
        return mark({ value: { type: 'object', properties }, provenance: propertiesOrigin({ properties }) });
      }
      case 'conversation': {
        const resolved = await messages({ input: value.messages, scope });
        return mark({ value: { type: 'conversation', messages: resolved }, provenance: mergeWorkflowOrigins({ origins: runtimeMessageValues({ messages: resolved }).map(value => origin({ value })) }) });
      }
      case 'array': {
        const items: RuntimeValue[] = [];
        try {
          for (const item of value.items) {
            items.push(await resolve({ value: item, scope }));
          }
          return mark({ value: { type: 'array', items }, provenance: propertiesOrigin({ properties: Object.fromEntries(items.map((item, index) => [index, item])) }) });
        } catch (error) {
          await releaseValues({ values: items });
          throw error;
        }
      }
      case 'concat': {
        const parts = value.items;
        async function* chunks(): AsyncGenerator<string> {
          for (const part of parts) {
            const item = await resolve({ value: part, scope });
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
          const item = await resolve({ value: part, scope });
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
        const left = await resolve({ value: value.left, scope });
        try {
          const right = await resolve({ value: value.right, scope });
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
        let current = await resolve({ value: value.value, scope });
        try {
          for (const key of value.path) {
            let next: RuntimeValue;
            if (current.type === 'model' && key === 'modelId') {
            // Comparison labels may use the public ID without exporting endpoint
            // headers or turning the whole model capability into ordinary JSON.
              next = { type: 'json', value: current.modelId };
            } else if (current.type === 'object' && typeof key === 'string' && Object.hasOwn(current.properties, key)) {
              next = retain({ value: current.properties[key]! });
            } else if (current.type === 'array' && typeof key === 'number' && current.items[key]) {
              next = retain({ value: current.items[key]! });
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
            const projected = mark({ value: next, provenance: workflowFieldOrigin({ origin: origin({ value: current }), key }) });
            await releaseValue({ value: current });
            current = projected;
          }
          return retain({ value: current });
        } finally {
          await releaseValue({ value: current });
        }
      }
      case 'filename': case 'format_number': case 'not_empty': {
        const item = await resolve({ value: value.value, scope });
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
    const result = await expression();
    // Only evaluated dependencies participate; short-circuited inputs stay unused.
    return origins.has(result) ? result : mark({ value: result, provenance: mergeWorkflowOrigins({ origins: dependencies }) });
  };
  async function* items({ source }: { source: RuntimeValue }): AsyncGenerator<RuntimeValue> {
    switch (source.type) {
    case 'array': for (const [index, value] of source.items.entries()) {
      yield mark({ value: retainValue({ value }), provenance: workflowFieldOrigin({ origin: origin({ value: source }), key: index }) });
    }
      return;
    case 'json':
      if (!Array.isArray(source.value)) {
        throw new Error('ForEach expects an array.');
      }
      for (const [index, value] of source.value.entries()) {
        yield mark({ value: { type: 'json', value }, provenance: workflowFieldOrigin({ origin: origin({ value: source }), key: index }) });
      }
      return;
    case 'range':
      for (const value of workflowRangeItems({ range: source })) {
        signal.throwIfAborted();
        yield mark({ value: { type: 'json', value }, provenance: origin({ value: source }) });
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
      yield mark({ value: { type: 'json', value }, provenance: origin({ value: source }) });
    }
  }
  const executeStep = async ({ step, scope, trace }: { step: WorkflowStep, scope: Scope, trace: number[] }): Promise<WorkflowOutputs> => {
    control.check();
    switch (step.type) {
    case 'value': return { value: await evaluate({ value: step.value, scope }) };
    case 'model_selection': return { value: mark({ value: { type: 'array', items: step.targets.map(target => ({ type: 'model', ...target })) }, provenance: workflowValueOrigin({ source: 'definition' }) }) };
    case 'parse_json': {
      const source = await evaluate({ value: step.source, scope });
      try {
        return { value: mark({ value: { type: 'json', value: parseWorkflowJson({ text: await readText({ value: source, maxBytes: WORKFLOW_INPUT_LIMIT, signal }) }) }, provenance: mergeWorkflowOrigins({ origins: [origin({ value: source })] }) }) };
      } finally {
        await releaseValue({ value: source });
      }
    }
    case 'tool_call': {
      const args = await evaluate({ value: step.arguments, scope });
      try {
        const request = resolveWorkflowToolRequest({ tool: step.tool, args: await materializeJson({ value: args, signal }) });
        signal.throwIfAborted();
        return externalOutputs({ outputs: await services.callTool({ input: { step, request, signal, store } }), source: 'tool_output' });
      } finally {
        await releaseValue({ value: args });
      }
    }
    case 'request_input': {
      const values = await record({ properties: { prompt: step.prompt, ...(step.choices === undefined ? {} : { choices: step.choices }) }, scope });
      try {
        const choices = values.choices === undefined ? undefined : workflowChoicesSchema.parse(await materializeJson({ value: values.choices, signal }));
        if (choices !== undefined && step.responseType !== 'text') {
          throw new Error('Fixed choices require a text response.');
        }
        const text = await services.requestInput({ step, prompt: await readText({ value: values.prompt!, maxBytes: 16384, signal }), choices, signal });
        signal.throwIfAborted();
        if (choices !== undefined && !choices.includes(text)) {
          throw new Error('Select one of the supplied choices.');
        }
        if (new TextEncoder().encode(text).byteLength > WORKFLOW_INPUT_LIMIT) {
          throw new Error('Interactive response exceeds the input limit.');
        }
        switch (step.responseType) {
        case 'json': return { value: mark({ value: { type: 'json', value: parseWorkflowJson({ text }) }, provenance: workflowValueOrigin({ source: 'interactive_input' }) }) };
        case 'text': return { value: mark({ value: { type: 'json', value: text }, provenance: workflowValueOrigin({ source: 'interactive_input' }) }) };
        default: {
          const exhaustive: never = step.responseType;
          throw new Error(`Unknown response type: ${exhaustive}`);
        }
        }
      } finally {
        await releaseValues({ values: Object.values(values) });
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
            return externalOutputs({ outputs: await services.generate({ input: { step, target: model, targetSources: workflowTargetSources({ origin: origin({ value: target }) }), conversation: [...history.messages, ...extra], signal, store } }), source: 'model_output' });
          } finally {
            await releaseValues({ values: runtimeMessageValues({ messages: extra }) });
          }
        } finally {
          await releaseValue({ value: conversation });
        }
      } finally {
        await releaseValue({ value: target });
      }
    }
    case 'image_generation': {
      const values = await record({
        properties: {
          ...step.parameters,
          model: step.model,
          prompt: step.prompt,
          ...(step.gpuBudgetMiB === undefined ? {} : { gpuBudgetMiB: step.gpuBudgetMiB }),
          ...(step.imageInputs === undefined ? {} : {
            strength: step.imageInputs.strength,
            ...(step.imageInputs.initImage === undefined ? {} : { initImage: step.imageInputs.initImage }),
            ...Object.fromEntries(step.imageInputs.referenceImages.map((value, index) => [`referenceImage${index}`, value])),
          }),
        },
        scope,
      });
      try {
        const request = await resolveWorkflowImageRequest({ values, signal });
        request.preview = step.preview;
        let images: WorkflowImageGenerationInput['images'];
        if (step.imageInputs !== undefined) {
          const binary = ({ value }: { value: RuntimeValue }): Extract<RuntimeValue, { type: 'binary' }> => {
            switch (value.type) {
            case 'binary': return value;
            case 'json': case 'model': case 'range': case 'text': case 'sequence': case 'array': case 'object': case 'conversation':
              throw new Error('Image inputs require binary file outputs.');
            default: {
              const exhaustive: never = value;
              throw new Error(String(exhaustive));
            }
            }
          };
          if (values.strength?.type !== 'json' || typeof values.strength.value !== 'number' || !Number.isFinite(values.strength.value) || values.strength.value < 0 || values.strength.value > 1) {
            throw new Error('Image strength requires a number from 0 to 1.');
          }
          images = {
            initImage: values.initImage === undefined ? undefined : binary({ value: values.initImage }),
            referenceImages: step.imageInputs.referenceImages.map((_, index) => binary({ value: values[`referenceImage${index}`]! })),
            strength: values.strength.value,
          };
        }
        return externalOutputs({
          outputs: await services.generateImage({ input: { step, request, images, targetSources: workflowOriginSources({ origin: origin({ value: values.model! }) }), signal, store } }),
          source: 'model_output',
        });
      } finally {
        await releaseValues({ values: Object.values(values) });
      }
    }
    case 'audio_generation': {
      const values = await record({ properties: { ...step.parameters, modelId: step.modelId, text: step.text, ...(step.reference === undefined ? {} : { reference: step.reference }) }, scope });
      try {
        const reference = values.reference;
        if (reference !== undefined && reference.type !== 'binary') {
          throw new Error('Audio reference requires a binary file output.');
        }
        const request = await resolveWorkflowAudioRequest({ values, signal });
        return externalOutputs({
          outputs: await services.generateAudio({
            input: {
              step,
              request,
              reference,
              onLimit: step.onLimit,
              targetSources: workflowOriginSources({ origin: origin({ value: values.modelId! }) }),
              signal,
              store,
            },
          }),
          source: 'model_output',
        });
      } finally {
        await releaseValues({ values: Object.values(values) });
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
          if (source.type !== 'json' || typeof source.value !== 'number' || !Number.isSafeInteger(source.value) || source.value < 0) {
            throw new Error('Repeat count must be a nonnegative safe integer.');
          }
          iterable = items({ source: mark({ value: { type: 'range', start: 0, end: source.value, step: 1 }, provenance: origin({ value: source }) }) });
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
        let loopOrigin = origin({ value: source });
        let emittedOrigin = workflowValueOrigin({ source: 'definition' });
        let stoppedBy: 'source_exhausted' | 'condition' = 'source_exhausted';
        for await (const item of iterable) {
          const nested: Scope = { outputs: new Map(), parent: scope };
          let next: Record<string, RuntimeValue> | undefined;
          try {
            await control.yieldToHost();
            control.iteration();
            loops.set(step.id, { index, item: includeItem ? item : undefined, state, origin: loopOrigin });
            await block({ steps: step.body.steps, scope: nested, trace: [...trace, index] });
            let stop = false;
            if (step.stopWhen !== undefined) {
              const condition = await evaluate({ value: step.stopWhen, scope: nested });
              try {
                if (condition.type !== 'json' || typeof condition.value !== 'boolean') {
                  throw new Error('The loop stop condition must be a boolean.');
                }
                stop = condition.value;
                loopOrigin = mergeWorkflowOrigins({ origins: [loopOrigin, origin({ value: condition })] });
              } finally {
                await releaseValue({ value: condition });
              }
            }
            // Stop observes this iteration's outputs and the incoming state.
            // Even the stopping iteration publishes its emit and commits next state.
            next = await record({ properties: Object.fromEntries(Object.entries(step.state).map(([key, value]) => [key, value.next])), scope: nested });
            if (step.emit !== undefined && writer) {
              const emitted = await evaluate({ value: step.emit, scope: nested });
              try {
                // One bounded summary for a streamed sequence, never per-item metadata.
                emittedOrigin = mergeWorkflowOrigins({ origins: [emittedOrigin, origin({ value: emitted })] });
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
            if (stop) {
              stoppedBy = 'condition';
              break;
            }
          } finally {
            loops.delete(step.id);
            if (next) {
              await releaseValues({ values: Object.values(next) });
            }
            await releaseValue({ value: item });
            await clear({ scope: nested });
          }
        }
        const result: WorkflowOutputs = {
          state: mark({ value: { type: 'object', properties: state }, provenance: propertiesOrigin({ properties: state }) }),
          iterations: mark({ value: { type: 'json', value: index }, provenance: loopOrigin }),
          stoppedBy: mark({ value: { type: 'json', value: stoppedBy }, provenance: loopOrigin }),
        };
        if (writer) {
          result.items = mark({ value: { type: 'sequence', output: await writer.seal() }, provenance: emittedOrigin });
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
        case 'read_file': return externalOutputs({ outputs: await services.readFile({ volumeId: step.volumeId, path, store, signal }), source: 'file_input' });
        case 'write_file': break;
        default: {
          const exhaustive: never = step;
          throw new Error(`Unknown file step: ${exhaustive}`);
        }
        }
        const source = await evaluate({ value: step.source, scope });
        try {
          return externalOutputs({ outputs: await services.writeFile({ step, path, source, signal }), source: 'file_input' });
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
      await control.yieldToHost();
      control.step();
      await services.onStep({ step, phase: 'running', trace, outputs: undefined });
      control.check();
      const outputs = await executeStep({ step, scope, trace });
      try {
        // A provider can resolve after cancellation. Never publish that late
        // result as a successful step, and release its owned output leases.
        control.check();
      } catch (error) {
        await releaseValues({ values: Object.values(outputs) });
        throw error;
      }
      Object.values(outputs).forEach(value => freezeRuntimeValue({ value }));
      Object.freeze(outputs);
      scope.outputs.set(step.id, outputs);
      await services.onStep({ step, phase: 'completed', trace, outputs });
    }
  };
  let status: WorkflowRunResult['status'] = 'completed', error: unknown;
  try {
    control.check();
    await block({ steps: snapshot.steps, scope: root, trace: [] });
    control.check();
  } catch (reason) {
    status = parentSignal.aborted ? 'cancelled' : 'failed';
    error = reason;
  } finally {
    control.close();
  }
  return { status, error, outputs: root.outputs, release: () => clear({ scope: root }) };
}

export const TEST_ONLY = {
};
