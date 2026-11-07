import type { JsonValue } from '@/01-models/lm';
import type { WorkflowDefinition, WorkflowStep, WorkflowValue, WorkflowMessage, WorkflowLoopState } from '@/01-models/workflow';
import { idToRaw, toWorkflowStepId, toVolumeId, toToolCallId, type WorkflowStepId } from '@/01-models/ids';
import { childWorkflowSteps, workflowOutputNames } from './definition';

/** An allowlisted structural projection, not a credential-name heuristic.
 * All authored data, bindings, labels, keys, paths, and authority are removed.
 * The result is intentionally incomplete until the recipient fills its inputs.
 */
export function shareWorkflowStructure({ definition }: { definition: WorkflowDefinition }): WorkflowDefinition {
  const ids = new Map<WorkflowStepId, WorkflowStepId>();
  const originals = new Map<WorkflowStepId, WorkflowStep>();
  const keys = new Map<string, string>();
  const calls = new Map<string, string>();
  const key = ({ text }: { text: string }): string => {
    const replacement = keys.get(text) ?? `field-${keys.size + 1}`;
    keys.set(text, replacement);
    return replacement;
  };
  const id = ({ source }: { source: WorkflowStepId }): WorkflowStepId => {
    const replacement = ids.get(source) ?? toWorkflowStepId({ raw: `step-${ids.size + 1}` });
    ids.set(source, replacement);
    return replacement;
  };
  const collect = ({ steps }: { steps: WorkflowStep[] }): void => {
    for (const step of steps) {
      originals.set(step.id, step);
      id({ source: step.id });
      childWorkflowSteps({ step }).forEach(steps => collect({ steps }));
    }
  };
  collect({ steps: definition.steps });
  const callId = ({ source }: { source: string }) => {
    const replacement = calls.get(source) ?? `call-${calls.size + 1}`;
    calls.set(source, replacement);
    return toToolCallId({ raw: replacement });
  };
  const json = ({ source }: { source: JsonValue }): JsonValue => {
    if (source === null) {
      return null;
    }
    switch (typeof source) {
    case 'string': return '';
    case 'number': return 0;
    case 'boolean': return false;
    case 'object': return Array.isArray(source)
      ? source.map(source => json({ source }))
      : Object.fromEntries(Object.entries(source).map(([name, source]) => [key({ text: name }), json({ source })]));
    default: {
      const exhaustive: never = source;
      throw new Error(String(exhaustive));
    }
    }
  };
  const path = ({ source }: { source: (string | number)[] }) => source.map(part => typeof part === 'string' ? key({ text: part }) : part);
  const messages = ({ source }: { source: WorkflowMessage[] }): WorkflowMessage[] => source.map(message => ({
    role: message.role,
    parts: message.parts.map(part => {
      switch (part.type) {
      case 'text': case 'reasoning': return { type: part.type, text: '' };
      case 'value': return { type: 'value', value: value({ source: part.value }) };
      case 'tool_call': return { type: 'tool_call', id: callId({ source: idToRaw({ id: part.id }) }), name: 'tool', arguments: '{}' };
      case 'tool_result': return { type: 'tool_result', id: callId({ source: idToRaw({ id: part.id }) }), status: part.status, code: part.code, content: value({ source: part.content }) };
      default: {
        const exhaustive: never = part;
        throw new Error(String(exhaustive));
      }
      }
    }),
  }));
  const value = ({ source }: { source: WorkflowValue }): WorkflowValue => {
    const type = source.type;
    switch (source.type) {
    case 'literal': return { type: 'literal', value: json({ source: source.value }) };
    case 'model': return { type: 'model', endpoint: { type: 'openai', url: '' }, modelId: '' };
    case 'step_output': {
      const step = originals.get(source.stepId);
      const output = step && step.type !== 'if' && workflowOutputNames({ step }).includes(source.output) ? source.output : key({ text: source.output });
      return { type: 'step_output', stepId: id({ source: source.stepId }), output };
    }
    case 'loop_item': case 'loop_index': return { type: source.type, stepId: id({ source: source.stepId }) };
    case 'loop_state': return { type: 'loop_state', stepId: id({ source: source.stepId }), key: key({ text: source.key }) };
    case 'array': case 'concat': case 'path': case 'all': case 'any': return { type: source.type, items: source.items.map(source => value({ source })) };
    case 'object': return { type: 'object', properties: record({ source: source.properties }) };
    case 'json_compose': return { type: 'json_compose', base: json({ source: source.base }), assignments: source.assignments.map(item => ({ path: path({ source: item.path }), value: value({ source: item.value }) })) };
    case 'range': return { type: 'range', start: value({ source: source.start }), end: optional({ source: source.end }), step: value({ source: source.step }) };
    case 'get': return { type: 'get', value: value({ source: source.value }), path: path({ source: source.path }) };
    case 'filename': case 'not': case 'not_empty': return { type: source.type, value: value({ source: source.value }) };
    case 'format_number': return { type: 'format_number', value: value({ source: source.value }), minDigits: 1 };
    case 'equals': return { type: 'equals', left: value({ source: source.left }), right: value({ source: source.right }) };
    case 'arithmetic': return { type: 'arithmetic', operator: source.operator, left: value({ source: source.left }), right: value({ source: source.right }) };
    case 'compare': return { type: 'compare', operator: source.operator, left: value({ source: source.left }), right: value({ source: source.right }) };
    case 'conversation': return { type: 'conversation', messages: messages({ source: source.messages }) };
    default: {
      const exhaustive: never = source;
      throw new Error(`Unknown structural expression: ${type} ${exhaustive}`);
    }
    }
  };
  const optional = ({ source }: { source: WorkflowValue | undefined }) => source === undefined ? undefined : value({ source });
  const record = ({ source }: { source: Record<string, WorkflowValue> }) => Object.fromEntries(Object.entries(source).map(([name, source]) => [key({ text: name }), value({ source })]));
  const state = ({ source }: { source: WorkflowLoopState }): WorkflowLoopState => Object.fromEntries(Object.entries(source).map(([name, item]) => [key({ text: name }), { initial: value({ source: item.initial }), next: value({ source: item.next }) }]));
  const steps = ({ source }: { source: WorkflowStep[] }): WorkflowStep[] => source.map(step => {
    const base = { id: id({ source: step.id }), name: `Step ${idToRaw({ id: id({ source: step.id }) }).slice(5)}` };
    switch (step.type) {
    case 'value': return { ...base, type: 'value', value: value({ source: step.value }) };
    case 'model_selection': return { ...base, type: 'model_selection', targets: step.targets.map(() => ({ endpoint: { type: 'openai', url: '' }, modelId: '', lmParameters: undefined })) };
    case 'parse_json': return { ...base, type: 'parse_json', source: value({ source: step.source }) };
    case 'text_generation': return { ...base, type: 'text_generation', target: value({ source: step.target }), conversation: value({ source: step.conversation }), appendMessages: messages({ source: step.appendMessages }), systemPrompt: undefined, lmParameters: undefined, toolConfigs: [], toolExecution: undefined };
    case 'audio_generation': return {
      ...base,
      type: 'audio_generation',
      modelId: value({ source: step.modelId }),
      text: value({ source: step.text }),
      reference: optional({ source: step.reference }),
      parameters: {
        language: value({ source: step.parameters.language }),
        audioBackend: value({ source: step.parameters.audioBackend }),
        contextTokens: value({ source: step.parameters.contextTokens }),
        maxFrames: value({ source: step.parameters.maxFrames }),
        temperature: value({ source: step.parameters.temperature }),
        topK: value({ source: step.parameters.topK }),
        topP: value({ source: step.parameters.topP }),
        seed: value({ source: step.parameters.seed }),
      },
      onLimit: 'error',
    };
    case 'image_generation': return {
      ...base,
      type: 'image_generation',
      model: value({ source: step.model }),
      prompt: value({ source: step.prompt }),
      parameters: {
        negativePrompt: value({ source: step.parameters.negativePrompt }),
        width: value({ source: step.parameters.width }),
        height: value({ source: step.parameters.height }),
        steps: value({ source: step.parameters.steps }),
        guidance: value({ source: step.parameters.guidance }),
        seed: value({ source: step.parameters.seed }),
        sampler: value({ source: step.parameters.sampler }),
        scheduler: value({ source: step.parameters.scheduler }),
        distilledGuidance: value({ source: step.parameters.distilledGuidance }),
        vaeTiling: value({ source: step.parameters.vaeTiling }),
        vaeTileSize: value({ source: step.parameters.vaeTileSize }),
        flashAttention: value({ source: step.parameters.flashAttention }),
        bf16WeightType: value({ source: step.parameters.bf16WeightType }),
        qwenVaePolicy: value({ source: step.parameters.qwenVaePolicy }),
        conditioningCacheSize: value({ source: step.parameters.conditioningCacheSize }),
        modelArguments: value({ source: step.parameters.modelArguments }),
        profile: value({ source: step.parameters.profile }),
        weightResidency: value({ source: step.parameters.weightResidency }),
      },
      gpuBudgetMiB: undefined,
      preview: undefined,
      imageInputs: step.imageInputs === undefined ? undefined : { initImage: optional({ source: step.imageInputs.initImage }), referenceImages: step.imageInputs.referenceImages.map(source => value({ source })), strength: value({ source: step.imageInputs.strength }) },
    };
    case 'tool_call': {
      const tool = (() => {
        switch (step.tool.name) {
        case 'shell_execute': return { name: 'shell_execute' as const, volumeId: toVolumeId({ raw: '' }), access: 'read-only' as const };
        case 'calculator': case 'wikipedia_search': case 'wikipedia_get_page': return { name: step.tool.name };
        default: {
          const exhaustive: never = step.tool;
          throw new Error(String(exhaustive));
        }
        }
      })();
      return { ...base, type: 'tool_call', tool, arguments: value({ source: step.arguments }), onError: 'fail' };
    }
    case 'request_input': return { ...base, type: 'request_input', prompt: value({ source: step.prompt }), responseType: step.responseType, choices: optional({ source: step.choices }) };
    case 'repeat': return { ...base, type: 'repeat', count: value({ source: step.count }), body: { steps: steps({ source: step.body.steps }) }, state: state({ source: step.state }), emit: optional({ source: step.emit }), stopWhen: optional({ source: step.stopWhen }) };
    case 'for_each': return { ...base, type: 'for_each', source: value({ source: step.source }), body: { steps: steps({ source: step.body.steps }) }, state: state({ source: step.state }), emit: optional({ source: step.emit }), stopWhen: optional({ source: step.stopWhen }) };
    case 'if': return { ...base, type: 'if', condition: value({ source: step.condition }), then: { steps: steps({ source: step.then.steps }), outputs: record({ source: step.then.outputs }) }, else: { steps: steps({ source: step.else.steps }), outputs: record({ source: step.else.outputs }) } };
    case 'read_file': return { ...base, type: 'read_file', volumeId: toVolumeId({ raw: '' }), relativePath: value({ source: step.relativePath }) };
    case 'write_file': return { ...base, type: 'write_file', volumeId: toVolumeId({ raw: '' }), relativePath: value({ source: step.relativePath }), source: value({ source: step.source }), format: step.format, onConflict: 'error' };
    default: {
      const exhaustive: never = step;
      throw new Error(String(exhaustive));
    }
    }
  });
  return { name: 'Shared workflow structure', steps: steps({ source: definition.steps }), executionLimits: undefined };
}

export const TEST_ONLY = {
};
