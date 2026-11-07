import { clonePlainData } from '@/utils/clone-plain-data';
import { workflowToolConfigurationIssues } from './tool-policy';
import { workflowChoicesSchema } from './input-choices';
import { workflowToolLiteralIssues } from './tool-input';
import type { WorkflowDefinition, WorkflowStep, WorkflowValue, WorkflowMessage } from '@/01-models/workflow';
import { workflowAudioLiteralIssues } from './audio-input';
import { workflowImageLiteralIssues } from './image-input';
import { workflowExecutionLimitIssues } from './execution-control';
import { analyzeWorkflowTypes } from './value-types';
import { validateJsonAssignments } from './json-composition';
import { generateId } from '@/01-models/id';
import { idToRaw, type WorkflowStepId } from '@/01-models/ids';

export type WorkflowIssue = { stepId: WorkflowStepId | undefined, path: string, message: string };

type ValueTransform = ({ value }: { value: WorkflowValue }) => WorkflowValue;

/** Only structural expression nodes are traversed. Literal JSON, including keys named id/type, is opaque. */
export function mapWorkflowValue({ value, transform }: { value: WorkflowValue, transform: ValueTransform }): WorkflowValue {
  const map = ({ value }: { value: WorkflowValue }) => mapWorkflowValue({ value, transform });
  switch (value.type) {
  case 'literal':
  case 'model':
  case 'step_output':
  case 'loop_item':
  case 'loop_index':
  case 'loop_state': return transform({ value });
  case 'array':
  case 'concat':
  case 'all':
  case 'any':
  case 'path': return transform({ value: { ...value, items: value.items.map(value => map({ value })) } });
  case 'object': return transform({ value: { ...value, properties: Object.fromEntries(Object.entries(value.properties).map(([key, child]) => [key, map({ value: child })])) } });
  case 'json_compose': return transform({ value: { ...value, assignments: value.assignments.map(item => ({ ...item, value: map({ value: item.value }) })) } });
  case 'range': return transform({ value: { ...value, start: map({ value: value.start }), step: map({ value: value.step }), end: value.end === undefined ? undefined : map({ value: value.end }) } });
  case 'get':
  case 'filename':
  case 'format_number':
  case 'not':
  case 'not_empty': return transform({ value: { ...value, value: map({ value: value.value }) } });
  case 'arithmetic':
  case 'compare':
  case 'equals': return transform({ value: { ...value, left: map({ value: value.left }), right: map({ value: value.right }) } });
  case 'conversation': return transform({ value: { ...value, messages: mapWorkflowMessages({ messages: value.messages, transform }) } });
  default: {
    const exhaustive: never = value;
    throw new Error(`Unknown expression: ${exhaustive}`);
  }
  }
}

export function mapWorkflowMessages({ messages, transform }: { messages: WorkflowMessage[], transform: ValueTransform }): WorkflowMessage[] {
  return messages.map(message => ({
    ...message,
    parts: message.parts.map(part => {
      switch (part.type) {
      case 'text': case 'reasoning':
      case 'tool_call': return part;
      case 'tool_result': return { ...part, content: mapWorkflowValue({ value: part.content, transform }) };
      case 'value': return { ...part, value: mapWorkflowValue({ value: part.value, transform }) };
      default: {
        const exhaustive: never = part;
        throw new Error(`Unknown message part: ${exhaustive}`);
      }
      }
    }),
  }));
}

export function childWorkflowSteps({ step }: { step: WorkflowStep }): WorkflowStep[][] {
  switch (step.type) {
  case 'repeat':
  case 'for_each': return [step.body.steps];
  case 'if': return [step.then.steps, step.else.steps];
  case 'value':
  case 'model_selection':
  case 'parse_json':
  case 'text_generation':
  case 'audio_generation':
  case 'image_generation':
  case 'tool_call':
  case 'request_input':
  case 'read_file':
  case 'write_file': return [];
  default: {
    const exhaustive: never = step;
    throw new Error(`Unknown step: ${exhaustive}`);
  }
  }
}

export function workflowOutputNames({ step }: { step: WorkflowStep }): string[] {
  switch (step.type) {
  case 'value':
  case 'model_selection':
  case 'parse_json':
  case 'request_input': return ['value'];
  case 'text_generation': return ['text', 'reasoning', 'conversation', 'metrics'];
  case 'audio_generation': return ['audio', 'metadata', 'complete'];
  case 'image_generation': return ['image', 'metadata'];
  case 'tool_call': return ['text', 'ok', 'metadata'];
  case 'read_file': return ['content', 'text', 'metadata'];
  case 'write_file': return ['file'];
  case 'repeat':
  case 'for_each': return step.emit === undefined ? ['state', 'iterations', 'stoppedBy'] : ['state', 'iterations', 'stoppedBy', 'items'];
  case 'if': return Object.keys(step.then.outputs);
  default: {
    const exhaustive: never = step;
    throw new Error(`Unknown step: ${exhaustive}`);
  }
  }
}

export function mapWorkflowSteps({ steps, transform, stepId }: {
  steps: WorkflowStep[], transform: ValueTransform, stepId: ({ id }: { id: WorkflowStepId }) => WorkflowStepId,
}): WorkflowStep[] {
  const map = ({ value }: { value: WorkflowValue }) => mapWorkflowValue({ value, transform });
  const children = ({ steps }: { steps: WorkflowStep[] }) => mapWorkflowSteps({ steps, transform, stepId });
  const record = ({ values }: { values: Record<string, WorkflowValue> }) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, map({ value: value })]));
  return steps.map(step => {
    const id = stepId({ id: step.id });
    switch (step.type) {
    case 'value': return { ...step, id, value: map({ value: step.value }) };
    case 'model_selection': return { ...step, id };
    case 'parse_json': return { ...step, id, source: map({ value: step.source }) };
    case 'text_generation': return { ...step, id, target: map({ value: step.target }), conversation: map({ value: step.conversation }), appendMessages: mapWorkflowMessages({ messages: step.appendMessages, transform }) };
    case 'audio_generation': return {
      ...step,
      id,
      modelId: map({ value: step.modelId }),
      text: map({ value: step.text }),
      reference: step.reference === undefined ? undefined : map({ value: step.reference }),
      parameters: {
        language: map({ value: step.parameters.language }),
        audioBackend: map({ value: step.parameters.audioBackend }),
        contextTokens: map({ value: step.parameters.contextTokens }),
        maxFrames: map({ value: step.parameters.maxFrames }),
        temperature: map({ value: step.parameters.temperature }),
        topK: map({ value: step.parameters.topK }),
        topP: map({ value: step.parameters.topP }),
        seed: map({ value: step.parameters.seed }),
      },
    };
    case 'image_generation': return {
      ...step,
      id,
      model: map({ value: step.model }),
      prompt: map({ value: step.prompt }),
      imageInputs: step.imageInputs === undefined ? undefined : {
        initImage: step.imageInputs.initImage === undefined ? undefined : map({ value: step.imageInputs.initImage }),
        referenceImages: step.imageInputs.referenceImages.map(value => map({ value })),
        strength: map({ value: step.imageInputs.strength }),
      },
      gpuBudgetMiB: step.gpuBudgetMiB === undefined ? undefined : map({ value: step.gpuBudgetMiB }),
      parameters: {
        negativePrompt: map({ value: step.parameters.negativePrompt }),
        width: map({ value: step.parameters.width }),
        height: map({ value: step.parameters.height }),
        steps: map({ value: step.parameters.steps }),
        guidance: map({ value: step.parameters.guidance }),
        seed: map({ value: step.parameters.seed }),
        sampler: map({ value: step.parameters.sampler }),
        scheduler: map({ value: step.parameters.scheduler }),
        distilledGuidance: map({ value: step.parameters.distilledGuidance }),
        vaeTiling: map({ value: step.parameters.vaeTiling }),
        vaeTileSize: map({ value: step.parameters.vaeTileSize }),
        flashAttention: map({ value: step.parameters.flashAttention }),
        bf16WeightType: map({ value: step.parameters.bf16WeightType }),
        qwenVaePolicy: map({ value: step.parameters.qwenVaePolicy }),
        conditioningCacheSize: map({ value: step.parameters.conditioningCacheSize }),
        modelArguments: map({ value: step.parameters.modelArguments }),
        profile: map({ value: step.parameters.profile }),
        weightResidency: map({ value: step.parameters.weightResidency }),
      },
    };
    case 'tool_call': return { ...step, id, arguments: map({ value: step.arguments }) };
    case 'request_input': return { ...step, id, prompt: map({ value: step.prompt }), choices: step.choices === undefined ? undefined : map({ value: step.choices }) };
    case 'read_file': return { ...step, id, relativePath: map({ value: step.relativePath }) };
    case 'write_file': return { ...step, id, relativePath: map({ value: step.relativePath }), source: map({ value: step.source }) };
    case 'repeat':
    case 'for_each': {
      const state = Object.fromEntries(Object.entries(step.state).map(([key, value]) => [key, { initial: map({ value: value.initial }), next: map({ value: value.next }) }]));
      const body = { steps: children({ steps: step.body.steps }) };
      const emit = step.emit === undefined ? undefined : map({ value: step.emit });
      const stopWhen = step.stopWhen === undefined ? undefined : map({ value: step.stopWhen });
      switch (step.type) {
      case 'repeat': return { ...step, id, count: map({ value: step.count }), state, body, emit, stopWhen };
      case 'for_each': return { ...step, id, source: map({ value: step.source }), state, body, emit, stopWhen };
      default: {
        const exhaustive: never = step;
        throw new Error(`Unknown loop: ${exhaustive}`);
      }
      }
    }
    case 'if': return { ...step, id, condition: map({ value: step.condition }), then: { steps: children({ steps: step.then.steps }), outputs: record({ values: step.then.outputs }) }, else: { steps: children({ steps: step.else.steps }), outputs: record({ values: step.else.outputs }) } };
    default: {
      const exhaustive: never = step;
      throw new Error(`Unknown step: ${exhaustive}`);
    }
    }
  });
}

export function copyWorkflowSteps({ steps }: { steps: WorkflowStep[] }): WorkflowStep[] {
  const ids = new Map<WorkflowStepId, WorkflowStepId>();
  const visit = ({ steps }: { steps: WorkflowStep[] }): void => {
    for (const step of steps) {
      ids.set(step.id, generateId<WorkflowStepId>());
      for (const child of childWorkflowSteps({ step })) {
        visit({ steps: child });
      }
    }
  };
  visit({ steps });
  return mapWorkflowSteps({
    steps: clonePlainData({ value: steps }),
    stepId: ({ id }) => ids.get(id) ?? id,
    transform: ({ value }) => {
      switch (value.type) {
      case 'step_output':
      case 'loop_item':
      case 'loop_index':
      case 'loop_state': return { ...value, stepId: ids.get(value.stepId) ?? value.stepId };
      case 'arithmetic': case 'compare': case 'all': case 'any': case 'not': case 'literal': case 'json_compose': case 'range': case 'model': case 'array': case 'concat': case 'path': case 'object': case 'get': case 'filename': case 'format_number': case 'equals': case 'not_empty': case 'conversation': return value;
      default: {
        const exhaustive: never = value;
        throw new Error(`Unknown expression: ${exhaustive}`);
      }
      }
    },
  });
}

/** Lexical visibility, not opportunistic scheduling, determines whether an output can be used. */
export function validateWorkflow({ definition }: { definition: WorkflowDefinition }): WorkflowIssue[] {
  const issues: WorkflowIssue[] = workflowExecutionLimitIssues({ limits: definition.executionLimits }).map(message => ({ stepId: undefined, path: 'executionLimits', message }));
  const ids = new Set<WorkflowStepId>();
  let count = 0;
  type Visible = Map<WorkflowStepId, string[]>;
  type Loops = Map<WorkflowStepId, { item: boolean, state: string[] }>;
  const add = ({ step, path, message }: { step: WorkflowStep, path: string, message: string }): void => {
    issues.push({ stepId: step.id, path, message });
  };
  const check = ({ value, visible, loops, step, path }: { value: WorkflowValue, visible: Visible, loops: Loops, step: WorkflowStep, path: string }): void => {
    mapWorkflowValue({
      value,
      transform: ({ value }) => {
        switch (value.type) {
        case 'step_output': if (!visible.get(value.stepId)?.includes(value.output)) {
          add({ step, path, message: `Unavailable output ${idToRaw({ id: value.stepId })}.${value.output}` });
        }
          break;
        case 'loop_item': if (!loops.get(value.stepId)?.item) {
          add({ step, path, message: 'Item reference is outside its ForEach.' });
        }
          break;
        case 'loop_index': if (!loops.has(value.stepId)) {
          add({ step, path, message: 'Index reference is outside its loop.' });
        }
          break;
        case 'loop_state': if (!loops.get(value.stepId)?.state.includes(value.key)) {
          add({ step, path, message: 'State reference is outside its loop or has an unknown key.' });
        }
          break;
        case 'format_number': if (!Number.isInteger(value.minDigits) || value.minDigits < 1 || value.minDigits > 12) {
          add({ step, path, message: 'Number padding must be between 1 and 12.' });
        }
          break;
        case 'get': if (value.path.some(key => typeof key === 'number' && (!Number.isSafeInteger(key) || key < 0))) {
          add({ step, path, message: 'Array indices must be nonnegative integers.' });
        }
          break;
        case 'model': if (!value.modelId.trim()) {
          add({ step, path, message: 'Select a model before running.' });
        }
          break;
        case 'json_compose':
          try {
            validateJsonAssignments({ base: value.base, paths: value.assignments.map(item => item.path) });
          } catch (error) {
            add({ step, path, message: error instanceof Error ? error.message : String(error) });
          }
          break;
        case 'range':
          for (const [field, expression] of [['start', value.start], ['step', value.step], ['end', value.end]] as const) {
            if (expression?.type === 'literal' && typeof expression.value === 'number' && (!Number.isSafeInteger(expression.value) || (field === 'step' && expression.value === 0))) {
              add({ step, path: `${path}.${field}`, message: 'A number range requires safe integers and a nonzero increment.' });
            }
          }
          break;
        case 'arithmetic': case 'compare': case 'all': case 'any': case 'not': case 'literal': case 'array': case 'concat': case 'path': case 'object': case 'filename': case 'equals': case 'not_empty': case 'conversation': break;
        default: {
          const exhaustive: never = value;
          throw new Error(`Unknown expression: ${exhaustive}`);
        }
        }
        return value;
      },
    });
  };
  const visit = ({ steps, parent, loops, depth }: { steps: WorkflowStep[], parent: Visible, loops: Loops, depth: number }): Visible => {
    const visible = new Map(parent);
    for (const step of steps) {
      if (++count > 1000 || depth > 16) {
        add({ step, path: 'steps', message: 'Workflow exceeds 1000 steps or 16 nested blocks.' });
        return visible;
      }
      if (ids.has(step.id)) {
        add({ step, path: 'id', message: 'Duplicate step ID.' });
      }
      ids.add(step.id);
      const input = ({ value, path }: { value: WorkflowValue, path: string }): void => check({ value, path, visible, loops, step });
      switch (step.type) {
      case 'value': input({ value: step.value, path: 'value' });
        break;
      case 'model_selection':
        if (step.targets.some(target => !target.modelId.trim())) {
          add({ step, path: 'targets', message: 'Select a model for each configured connection.' });
        }
        break;
      case 'parse_json': input({ value: step.source, path: 'source' });
        break;
      case 'text_generation':
        input({ value: step.target, path: 'target' });
        input({ value: step.conversation, path: 'conversation' });
        input({ value: { type: 'conversation', messages: step.appendMessages }, path: 'appendMessages' });
        for (const issue of workflowToolConfigurationIssues({ step })) {
          add({ step, ...issue });
        }
        break;
      case 'audio_generation':
        input({ value: step.modelId, path: 'modelId' });
        input({ value: step.text, path: 'text' });
        if (step.reference !== undefined) {
          input({ value: step.reference, path: 'reference' });
        }
        for (const [key, value] of Object.entries(step.parameters)) {
          input({ value, path: `parameters.${key}` });
        }
        for (const issue of workflowAudioLiteralIssues({ step })) {
          add({ step, ...issue });
        }
        break;
      case 'image_generation':
        input({ value: step.model, path: 'model' });
        input({ value: step.prompt, path: 'prompt' });
        if (step.imageInputs !== undefined) {
          if (step.imageInputs.initImage !== undefined) {
            input({ value: step.imageInputs.initImage, path: 'imageInputs.initImage' });
          }
          input({ value: step.imageInputs.strength, path: 'imageInputs.strength' });
          step.imageInputs.referenceImages.forEach((value, index) => input({ value, path: `imageInputs.referenceImages[${index}]` }));
          if (step.imageInputs.referenceImages.length > 8) {
            add({ step, path: 'imageInputs.referenceImages', message: 'At most eight reference images can be used per generation.' });
          }
        }
        if (step.gpuBudgetMiB !== undefined) {
          input({ value: step.gpuBudgetMiB, path: 'gpuBudgetMiB' });
        }
        for (const [key, value] of Object.entries(step.parameters)) {
          input({ value, path: `parameters.${key}` });
        }
        for (const issue of workflowImageLiteralIssues({ step })) {
          add({ step, ...issue });
        }
        break;
      case 'tool_call':
        input({ value: step.arguments, path: 'arguments' });
        for (const issue of workflowToolLiteralIssues({ step })) {
          add({ step, ...issue });
        }
        if (step.tool.name === 'shell_execute' && !idToRaw({ id: step.tool.volumeId })) {
          add({ step, path: 'tool.volumeId', message: 'Select a folder before running.' });
        }
        break;
      case 'request_input':
        input({ value: step.prompt, path: 'prompt' });
        if (step.choices !== undefined) {
          input({ value: step.choices, path: 'choices' });
          switch (step.responseType) {
          case 'text': break;
          case 'json': add({ step, path: 'responseType', message: 'Fixed choices require a text response.' });
            break;
          default: {
            const exhaustive: never = step.responseType;
            throw new Error(String(exhaustive));
          }
          }
          if (step.choices.type === 'literal' && !workflowChoicesSchema.safeParse(step.choices.value).success) {
            add({ step, path: 'choices', message: 'Provide 2–10 distinct nonblank single-line choices, at most 200 characters each.' });
          }
        }
        break;
      case 'read_file': if (!idToRaw({ id: step.volumeId })) {
        add({ step, path: 'volumeId', message: 'Select a folder before running.' });
      }
        input({ value: step.relativePath, path: 'relativePath' });
        break;
      case 'write_file': if (!idToRaw({ id: step.volumeId })) {
        add({ step, path: 'volumeId', message: 'Select a folder before running.' });
      }
        input({ value: step.relativePath, path: 'relativePath' });
        input({ value: step.source, path: 'source' });
        break;
      case 'repeat':
      case 'for_each': {
        switch (step.type) {
        case 'repeat': input({ value: step.count, path: 'count' });
          break;
        case 'for_each': input({ value: step.source, path: 'source' });
          break;
        default: {
          const exhaustive: never = step;
          throw new Error(`Unknown loop: ${exhaustive}`);
        }
        }
        for (const [key, state] of Object.entries(step.state)) {
          input({ value: state.initial, path: `state.${key}.initial` });
        }
        const nestedLoops = new Map(loops);
        nestedLoops.set(step.id, { item: step.type === 'for_each', state: Object.keys(step.state) });
        const nested = visit({ steps: step.body.steps, parent: visible, loops: nestedLoops, depth: depth + 1 });
        for (const [key, state] of Object.entries(step.state)) {
          check({ value: state.next, visible: nested, loops: nestedLoops, step, path: `state.${key}.next` });
        }
        if (step.emit !== undefined) {
          check({ value: step.emit, visible: nested, loops: nestedLoops, step, path: 'emit' });
        }
        if (step.stopWhen !== undefined) {
          check({ value: step.stopWhen, visible: nested, loops: nestedLoops, step, path: 'stopWhen' });
        }
        break;
      }
      case 'if': {
        input({ value: step.condition, path: 'condition' });
        const thenKeys = Object.keys(step.then.outputs).sort(), elseKeys = Object.keys(step.else.outputs).sort();
        if (JSON.stringify(thenKeys) !== JSON.stringify(elseKeys)) {
          add({ step, path: 'outputs', message: 'Both branches must expose the same output names.' });
        }
        for (const branch of [step.then, step.else]) {
          const nested = visit({ steps: branch.steps, parent: visible, loops, depth: depth + 1 });
          for (const [key, value] of Object.entries(branch.outputs)) {
            check({ value, visible: nested, loops, step, path: `outputs.${key}` });
          }
        }
        break;
      }
      default: {
        const exhaustive: never = step;
        throw new Error(`Unknown step: ${exhaustive}`);
      }
      }
      visible.set(step.id, workflowOutputNames({ step }));
    }
    return visible;
  };
  visit({ steps: definition.steps, parent: new Map(), loops: new Map(), depth: 0 });
  return [...issues, ...analyzeWorkflowTypes({ definition }).problems];
}

export const TEST_ONLY = {
};
