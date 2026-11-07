import { z } from 'zod';
import type { WorkflowValue, WorkflowMessage, WorkflowStep, WorkflowDefinition, WorkflowDocument, WorkflowLoopState, WorkflowBranch, WorkflowModelConfiguration, WorkflowRunRecord } from '@/01-models/workflow';
import { idToRaw, toWorkflowId, toWorkflowRunId, toWorkflowStepId, toVolumeId, toToolCallId } from '@/01-models/ids';
import type { ExperimentalWorkflowValueDto, ExperimentalWorkflowMessageDto, ExperimentalWorkflowStepDto, ExperimentalWorkflowDefinitionDto, ExperimentalWorkflowDto, ExperimentalWorkflowModelConfigurationDto, ExperimentalWorkflowRunDto } from '@/00-storage/00-dto/experimental-workflow.dto';
import type { SystemPrompt } from '@/01-models/types';
import type { SystemPromptDto } from '@/00-storage/00-dto/dto';
import { endpointToDomain, endpointToDto, lmParametersToDomain, lmParametersToDto, toolConfigToDomain, toolConfigToDto } from './mappers';
import type { WorkflowExecutionLimits } from '@/01-models/workflow';
import { exactObject } from '@/utils/exact-object';

function copyExecutionLimits({ limits }: { limits: WorkflowExecutionLimits }): WorkflowExecutionLimits {
  const { maxLoopIterations, maxStepExecutions, maxValueEvaluations, timeoutMs, ...unhandled } = limits;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<WorkflowExecutionLimits>()({ maxLoopIterations, maxStepExecutions, maxValueEvaluations, timeoutMs });
}

function workflowSystemPromptToDomain({ dto }: { dto: SystemPromptDto | undefined }): SystemPrompt | undefined {
  if (dto === undefined) {
    return undefined;
  }
  const { behavior, content, experimental: _experimental, ...unhandled } = dto;
  unhandled satisfies Record<PropertyKey, never>;
  switch (behavior) {
  case 'override': return { behavior, content };
  case 'append': return { behavior, content };
  default: {
    const exhaustive: never = behavior;
    throw new Error(String(exhaustive));
  }
  }
}

export function workflowValueToDomain({ dto }: { dto: ExperimentalWorkflowValueDto }): WorkflowValue {
  switch (dto.type) {
  case 'literal': {
    const { type, value, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, value: z.json().parse(value) });
  }
  case 'model': {
    const { type, endpoint, modelId, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, endpoint: endpointToDomain({ dto: endpoint }), modelId });
  }
  case 'step_output': {
    const { type, stepId, output, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, stepId: toWorkflowStepId({ raw: stepId }), output });
  }
  case 'loop_item': case 'loop_index': {
    const { type, stepId, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, stepId: toWorkflowStepId({ raw: stepId }) });
  }
  case 'loop_state': {
    const { type, stepId, key, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, stepId: toWorkflowStepId({ raw: stepId }), key });
  }
  case 'array': case 'concat': case 'path': case 'all': case 'any': {
    const { type, items, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, items: items.map(value => workflowValueToDomain({ dto: value })) });
  }
  case 'object': {
    const { type, properties, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, workflowValueToDomain({ dto: value })])) });
  }
  case 'json_compose': {
    const { type, base, assignments, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({
      type,
      base: z.json().parse(base),
      assignments: assignments.map(assignment => {
        const { path, value, ...unhandled } = assignment;
      unhandled satisfies Record<PropertyKey, never>;
      return { path: [...path], value: workflowValueToDomain({ dto: value }) };
      }),
    });
  }
  case 'range': {
    const { type, start, end, step, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, start: workflowValueToDomain({ dto: start }), end: end === undefined ? undefined : workflowValueToDomain({ dto: end }), step: workflowValueToDomain({ dto: step }) });
  }
  case 'get': {
    const { type, value, path, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, value: workflowValueToDomain({ dto: value }), path: [...path] });
  }
  case 'filename': case 'not_empty': case 'not': {
    const { type, value, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, value: workflowValueToDomain({ dto: value }) });
  }
  case 'format_number': {
    const { type, value, minDigits, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, value: workflowValueToDomain({ dto: value }), minDigits });
  }
  case 'arithmetic': case 'compare': {
    const { type, operator, left, right, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    const values = { left: workflowValueToDomain({ dto: left }), right: workflowValueToDomain({ dto: right }) };
    switch (type) {
    case 'arithmetic': return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, operator, ...values });
    case 'compare': return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, operator, ...values });
    default: {
      const exhaustive: never = type;
      throw new Error(String(exhaustive));
    }
    }
  }
  case 'equals': {
    const { type, left, right, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, left: workflowValueToDomain({ dto: left }), right: workflowValueToDomain({ dto: right }) });
  }
  case 'conversation': {
    const { type, messages, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, messages: messages.map(message => workflowMessageToDomain({ dto: message })) });
  }
  default: {
    const exhaustive: never = dto;
    throw new Error(String(exhaustive));
  }
  }
}

export function workflowMessageToDomain({ dto }: { dto: Extract<ExperimentalWorkflowValueDto, { type: 'conversation' }>['messages'][number] }): WorkflowMessage {
  const { role, parts, ...unhandled } = dto;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<WorkflowMessage>()({
    role,
    parts: parts.map(part => {
      switch (part.type) {
      case 'text': case 'reasoning': {
        const { type, text, ...unhandled } = part;
        unhandled satisfies Record<PropertyKey, never>;
        return { type, text };
      }
      case 'value': {
        const { type, value, ...unhandled } = part;
        unhandled satisfies Record<PropertyKey, never>;
        return { type, value: workflowValueToDomain({ dto: value }) };
      }
      case 'tool_call': {
        const { type, id, name, arguments: args, ...unhandled } = part;
        unhandled satisfies Record<PropertyKey, never>;
        return { type, id: toToolCallId({ raw: id }), name, arguments: args };
      }
      case 'tool_result': {
        const { type, id, status, code, content, ...unhandled } = part;
        unhandled satisfies Record<PropertyKey, never>;
        return { type, id: toToolCallId({ raw: id }), status, code, content: workflowValueToDomain({ dto: content }) };
      }
      default: {
        const exhaustive: never = part;
        throw new Error(String(exhaustive));
      }
      }
    }),
  });
}

function workflowStateToDomain({ state }: { state: Extract<ExperimentalWorkflowStepDto, { type: 'repeat' }>['state'] }): WorkflowLoopState {
  return Object.fromEntries(Object.entries(state).map(([key, entry]) => {
    const { initial, next, ...unhandled } = entry;
    unhandled satisfies Record<PropertyKey, never>;
    return [key, { initial: workflowValueToDomain({ dto: initial }), next: workflowValueToDomain({ dto: next }) }];
  }));
}

function workflowBranchToDomain({ branch }: { branch: Extract<ExperimentalWorkflowStepDto, { type: 'if' }>['then'] }): WorkflowBranch {
  const { steps, outputs, ...unhandled } = branch;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<WorkflowBranch>()({
    steps: steps.map(step => workflowStepToDomain({ dto: step })),
    outputs: Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, workflowValueToDomain({ dto: value })])),
  });
}

export function workflowStepToDomain({ dto }: { dto: ExperimentalWorkflowStepDto }): WorkflowStep {
  const { id, name, ...body } = dto;
  const base = { id: toWorkflowStepId({ raw: id }), name };
  switch (body.type) {
  case 'value': {
    const { type, value, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowStep, { type: typeof type }>>()({ ...base, type, value: workflowValueToDomain({ dto: value }) });
  }
  case 'model_selection': {
    const { type, targets, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowStep, { type: typeof type }>>()({ ...base, type, targets: targets.map(target => workflowModelConfigurationToDomain({ dto: target })) });
  }
  case 'parse_json': {
    const { type, source, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowStep, { type: typeof type }>>()({ ...base, type, source: workflowValueToDomain({ dto: source }) });
  }
  case 'text_generation': {
    const { type, target, conversation, appendMessages, systemPrompt, lmParameters, toolConfigs, toolExecution, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowStep, { type: typeof type }>>()({
      ...base,
      type,
      target: workflowValueToDomain({ dto: target }),
      conversation: workflowValueToDomain({ dto: conversation }),
      appendMessages: appendMessages.map(message => workflowMessageToDomain({ dto: message })),
      systemPrompt: workflowSystemPromptToDomain({ dto: systemPrompt }),
      lmParameters: lmParametersToDomain({ dto: lmParameters }),
      toolConfigs: toolConfigs.map(config => toolConfigToDomain({ dto: config })),
      toolExecution: toolExecution === undefined ? undefined : (() => {
        const { maxRounds, maxCalls, shell, ...unhandled } = toolExecution;
        unhandled satisfies Record<PropertyKey, never>;
        if (shell) {
          const { volumeId: _volumeId, access: _access, ...unhandledShell } = shell;
          unhandledShell satisfies Record<PropertyKey, never>;
        }
        return { maxRounds, maxCalls, shell: shell === undefined ? undefined : { volumeId: toVolumeId({ raw: shell.volumeId }), access: shell.access } };
      })(),
    });
  }
  case 'audio_generation': {
    const { type, modelId, text, reference, parameters, onLimit, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    const { language, audioBackend, contextTokens, maxFrames, temperature, topK, topP, seed, ...unhandledParameters } = parameters;
    unhandledParameters satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowStep, { type: typeof type }>>()({
      ...base,
      type,
      modelId: workflowValueToDomain({ dto: modelId }),
      text: workflowValueToDomain({ dto: text }),
      reference: reference === undefined ? undefined : workflowValueToDomain({ dto: reference }),
      parameters: {
        language: workflowValueToDomain({ dto: language }),
        audioBackend: workflowValueToDomain({ dto: audioBackend }),
        contextTokens: workflowValueToDomain({ dto: contextTokens }),
        maxFrames: workflowValueToDomain({ dto: maxFrames }),
        temperature: workflowValueToDomain({ dto: temperature }),
        topK: workflowValueToDomain({ dto: topK }),
        topP: workflowValueToDomain({ dto: topP }),
        seed: workflowValueToDomain({ dto: seed }),
      },
      onLimit,
    });
  }
  case 'image_generation': {
    const { type, model, prompt, parameters, gpuBudgetMiB, imageInputs, preview, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    const { negativePrompt, width, height, steps, guidance, seed, sampler, scheduler, distilledGuidance, vaeTiling, vaeTileSize, flashAttention, bf16WeightType, qwenVaePolicy, conditioningCacheSize, modelArguments, profile, weightResidency, ...unhandledParameters } = parameters;
    unhandledParameters satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowStep, { type: typeof type }>>()({
      ...base,
      type,
      model: workflowValueToDomain({ dto: model }),
      prompt: workflowValueToDomain({ dto: prompt }),
      parameters: {
        negativePrompt: workflowValueToDomain({ dto: negativePrompt }),
        width: workflowValueToDomain({ dto: width }),
        height: workflowValueToDomain({ dto: height }),
        steps: workflowValueToDomain({ dto: steps }),
        guidance: workflowValueToDomain({ dto: guidance }),
        seed: workflowValueToDomain({ dto: seed }),
        sampler: workflowValueToDomain({ dto: sampler }),
        scheduler: workflowValueToDomain({ dto: scheduler }),
        distilledGuidance: workflowValueToDomain({ dto: distilledGuidance }),
        vaeTiling: workflowValueToDomain({ dto: vaeTiling }),
        vaeTileSize: workflowValueToDomain({ dto: vaeTileSize }),
        flashAttention: workflowValueToDomain({ dto: flashAttention }),
        bf16WeightType: workflowValueToDomain({ dto: bf16WeightType }),
        qwenVaePolicy: workflowValueToDomain({ dto: qwenVaePolicy }),
        conditioningCacheSize: workflowValueToDomain({ dto: conditioningCacheSize }),
        modelArguments: workflowValueToDomain({ dto: modelArguments }),
        profile: workflowValueToDomain({ dto: profile }),
        weightResidency: workflowValueToDomain({ dto: weightResidency }),
      },
      gpuBudgetMiB: gpuBudgetMiB === undefined ? undefined : workflowValueToDomain({ dto: gpuBudgetMiB }),
      imageInputs: imageInputs === undefined ? undefined : (() => {
        const { initImage, referenceImages, strength, ...unhandled } = imageInputs;
        unhandled satisfies Record<PropertyKey, never>;
        return {
          initImage: initImage === undefined ? undefined : workflowValueToDomain({ dto: initImage }),
          referenceImages: referenceImages.map(value => workflowValueToDomain({ dto: value })),
          strength: workflowValueToDomain({ dto: strength }),
        };
      })(),
      preview: preview === undefined ? undefined : (() => {
        const { enabled, interval, startStep, mode, maxEdge, ...unhandled } = preview;
        unhandled satisfies Record<PropertyKey, never>;
        return { enabled, interval, startStep, mode, maxEdge };
      })(),
    });
  }
  case 'tool_call': {
    const { type, tool, arguments: argumentsValue, onError, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    const selection = (() => {
      switch (tool.name) {
      case 'calculator': case 'wikipedia_search': case 'wikipedia_get_page': {
        const { name, ...rest } = tool;
        rest satisfies Record<PropertyKey, never>;
        return { name };
      }
      case 'shell_execute': {
        const { name, volumeId, access, ...rest } = tool;
        rest satisfies Record<PropertyKey, never>;
        return { name, volumeId: toVolumeId({ raw: volumeId }), access };
      }
      default: {
        const exhaustive: never = tool;
        throw new Error(String(exhaustive));
      }
      }
    })();
    return exactObject<Extract<WorkflowStep, { type: typeof type }>>()({ ...base, type, tool: selection, arguments: workflowValueToDomain({ dto: argumentsValue }), onError });
  }
  case 'request_input': {
    const { type, prompt, responseType, choices, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowStep, { type: typeof type }>>()({ ...base, type, prompt: workflowValueToDomain({ dto: prompt }), responseType, choices: choices === undefined ? undefined : workflowValueToDomain({ dto: choices }) });
  }
  case 'repeat': {
    const { type, count, state, body: block, emit, stopWhen, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowStep, { type: typeof type }>>()({ ...base, type, count: workflowValueToDomain({ dto: count }), state: workflowStateToDomain({ state }), body: { steps: block.steps.map(step => workflowStepToDomain({ dto: step })) }, emit: emit === undefined ? undefined : workflowValueToDomain({ dto: emit }), stopWhen: stopWhen === undefined ? undefined : workflowValueToDomain({ dto: stopWhen }) });
  }
  case 'for_each': {
    const { type, source, state, body: block, emit, stopWhen, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowStep, { type: typeof type }>>()({ ...base, type, source: workflowValueToDomain({ dto: source }), state: workflowStateToDomain({ state }), body: { steps: block.steps.map(step => workflowStepToDomain({ dto: step })) }, emit: emit === undefined ? undefined : workflowValueToDomain({ dto: emit }), stopWhen: stopWhen === undefined ? undefined : workflowValueToDomain({ dto: stopWhen }) });
  }
  case 'if': {
    const { type, condition, then, else: otherwise, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowStep, { type: typeof type }>>()({ ...base, type, condition: workflowValueToDomain({ dto: condition }), then: workflowBranchToDomain({ branch: then }), else: workflowBranchToDomain({ branch: otherwise }) });
  }
  case 'read_file': {
    const { type, volumeId, relativePath, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowStep, { type: typeof type }>>()({ ...base, type, volumeId: toVolumeId({ raw: volumeId }), relativePath: workflowValueToDomain({ dto: relativePath }) });
  }
  case 'write_file': {
    const { type, volumeId, relativePath, source, format, onConflict, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowStep, { type: typeof type }>>()({ ...base, type, volumeId: toVolumeId({ raw: volumeId }), relativePath: workflowValueToDomain({ dto: relativePath }), source: workflowValueToDomain({ dto: source }), format, onConflict });
  }
  default: {
    const exhaustive: never = body;
    throw new Error(String(exhaustive));
  }
  }
}

export function workflowDefinitionToDomain({ dto }: { dto: ExperimentalWorkflowDefinitionDto }): WorkflowDefinition {
  const { name, steps, executionLimits, ...unhandled } = dto;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<WorkflowDefinition>()({ name, steps: steps.map(step => workflowStepToDomain({ dto: step })), executionLimits: executionLimits === undefined ? undefined : copyExecutionLimits({ limits: executionLimits }) });
}

export function workflowDocumentToDomain({ dto }: { dto: ExperimentalWorkflowDto }): WorkflowDocument {
  const { id, kind, createdAt, updatedAt, definition, ...unhandled } = dto;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<WorkflowDocument>()({
    id: toWorkflowId({ raw: id }),
    kind,
    createdAt,
    updatedAt,
    definition: workflowDefinitionToDomain({ dto: definition }),
  });
}

export function workflowValueToDto({ domain }: { domain: WorkflowValue }): ExperimentalWorkflowValueDto {
  switch (domain.type) {
  case 'literal': {
    const { type, value, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, value: value });
  }
  case 'model': {
    const { type, endpoint, modelId, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, endpoint: endpointToDto({ endpoint }), modelId });
  }
  case 'step_output': {
    const { type, stepId, output, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, stepId: idToRaw({ id: stepId }), output });
  }
  case 'loop_item': case 'loop_index': {
    const { type, stepId, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, stepId: idToRaw({ id: stepId }) });
  }
  case 'loop_state': {
    const { type, stepId, key, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, stepId: idToRaw({ id: stepId }), key });
  }
  case 'array': case 'concat': case 'path': case 'all': case 'any': {
    const { type, items, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, items: items.map(value => workflowValueToDto({ domain: value })) });
  }
  case 'object': {
    const { type, properties, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, workflowValueToDto({ domain: value })])) });
  }
  case 'json_compose': {
    const { type, base, assignments, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({
      type,
      base: z.json().parse(base),
      assignments: assignments.map(assignment => {
        const { path, value, ...unhandled } = assignment;
      unhandled satisfies Record<PropertyKey, never>;
      return { path: [...path], value: workflowValueToDto({ domain: value }) };
      }),
    });
  }
  case 'range': {
    const { type, start, end, step, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, start: workflowValueToDto({ domain: start }), end: end === undefined ? undefined : workflowValueToDto({ domain: end }), step: workflowValueToDto({ domain: step }) });
  }
  case 'get': {
    const { type, value, path, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, value: workflowValueToDto({ domain: value }), path: [...path] });
  }
  case 'filename': case 'not_empty': case 'not': {
    const { type, value, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, value: workflowValueToDto({ domain: value }) });
  }
  case 'format_number': {
    const { type, value, minDigits, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, value: workflowValueToDto({ domain: value }), minDigits });
  }
  case 'arithmetic': case 'compare': {
    const { type, operator, left, right, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    const values = { left: workflowValueToDto({ domain: left }), right: workflowValueToDto({ domain: right }) };
    switch (type) {
    case 'arithmetic': return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, operator, ...values });
    case 'compare': return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, operator, ...values });
    default: {
      const exhaustive: never = type;
      throw new Error(String(exhaustive));
    }
    }
  }
  case 'equals': {
    const { type, left, right, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, left: workflowValueToDto({ domain: left }), right: workflowValueToDto({ domain: right }) });
  }
  case 'conversation': {
    const { type, messages, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, messages: messages.map(message => workflowMessageToDto({ domain: message })) });
  }
  default: {
    const exhaustive: never = domain;
    throw new Error(String(exhaustive));
  }
  }
}

export function workflowMessageToDto({ domain }: { domain: WorkflowMessage }): ExperimentalWorkflowMessageDto {
  const { role, parts, ...unhandled } = domain;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<ExperimentalWorkflowMessageDto>()({
    role,
    parts: parts.map(part => {
      switch (part.type) {
      case 'text': case 'reasoning': {
        const { type, text, ...unhandled } = part;
        unhandled satisfies Record<PropertyKey, never>;
        return { type, text };
      }
      case 'value': {
        const { type, value, ...unhandled } = part;
        unhandled satisfies Record<PropertyKey, never>;
        return { type, value: workflowValueToDto({ domain: value }) };
      }
      case 'tool_call': {
        const { type, id, name, arguments: args, ...unhandled } = part;
        unhandled satisfies Record<PropertyKey, never>;
        return { type, id: idToRaw({ id }), name, arguments: args };
      }
      case 'tool_result': {
        const { type, id, status, code, content, ...unhandled } = part;
        unhandled satisfies Record<PropertyKey, never>;
        return { type, id: idToRaw({ id }), status, code, content: workflowValueToDto({ domain: content }) };
      }
      default: {
        const exhaustive: never = part;
        throw new Error(String(exhaustive));
      }
      }
    }),
  });
}

function workflowStateToDto({ state }: { state: WorkflowLoopState }): Extract<ExperimentalWorkflowStepDto, { type: 'repeat' }>['state'] {
  return Object.fromEntries(Object.entries(state).map(([key, entry]) => {
    const { initial, next, ...unhandled } = entry;
    unhandled satisfies Record<PropertyKey, never>;
    return [key, { initial: workflowValueToDto({ domain: initial }), next: workflowValueToDto({ domain: next }) }];
  }));
}

function workflowBranchToDto({ branch }: { branch: WorkflowBranch }): Extract<ExperimentalWorkflowStepDto, { type: 'if' }>['then'] {
  const { steps, outputs, ...unhandled } = branch;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<Extract<ExperimentalWorkflowStepDto, { type: 'if' }>['then']>()({
    steps: steps.map(step => workflowStepToDto({ domain: step })),
    outputs: Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, workflowValueToDto({ domain: value })])),
  });
}

export function workflowStepToDto({ domain }: { domain: WorkflowStep }): ExperimentalWorkflowStepDto {
  const { id, name, ...body } = domain;
  const base = { id: idToRaw({ id: id }), name };
  switch (body.type) {
  case 'value': {
    const { type, value, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowStepDto, { type: typeof type }>>()({ ...base, type, value: workflowValueToDto({ domain: value }) });
  }
  case 'model_selection': {
    const { type, targets, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowStepDto, { type: typeof type }>>()({ ...base, type, targets: targets.map(target => workflowModelConfigurationToDto({ domain: target })) });
  }
  case 'parse_json': {
    const { type, source, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowStepDto, { type: typeof type }>>()({ ...base, type, source: workflowValueToDto({ domain: source }) });
  }
  case 'text_generation': {
    const { type, target, conversation, appendMessages, systemPrompt, lmParameters, toolConfigs, toolExecution, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowStepDto, { type: typeof type }>>()({
      ...base,
      type,
      target: workflowValueToDto({ domain: target }),
      conversation: workflowValueToDto({ domain: conversation }),
      appendMessages: appendMessages.map(message => workflowMessageToDto({ domain: message })),
      systemPrompt: systemPrompt,
      lmParameters: lmParametersToDto({ domain: lmParameters }),
      toolConfigs: toolConfigs.map(config => toolConfigToDto({ domain: config })),
      toolExecution: toolExecution === undefined ? undefined : (() => {
        const { maxRounds, maxCalls, shell, ...unhandled } = toolExecution;
        unhandled satisfies Record<PropertyKey, never>;
        if (shell) {
          const { volumeId: _volumeId, access: _access, ...unhandledShell } = shell;
          unhandledShell satisfies Record<PropertyKey, never>;
        }
        return { maxRounds, maxCalls, shell: shell === undefined ? undefined : { volumeId: idToRaw({ id: shell.volumeId }), access: shell.access } };
      })(),
    });
  }
  case 'audio_generation': {
    const { type, modelId, text, reference, parameters, onLimit, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    const { language, audioBackend, contextTokens, maxFrames, temperature, topK, topP, seed, ...unhandledParameters } = parameters;
    unhandledParameters satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowStepDto, { type: typeof type }>>()({
      ...base,
      type,
      modelId: workflowValueToDto({ domain: modelId }),
      text: workflowValueToDto({ domain: text }),
      reference: reference === undefined ? undefined : workflowValueToDto({ domain: reference }),
      parameters: {
        language: workflowValueToDto({ domain: language }),
        audioBackend: workflowValueToDto({ domain: audioBackend }),
        contextTokens: workflowValueToDto({ domain: contextTokens }),
        maxFrames: workflowValueToDto({ domain: maxFrames }),
        temperature: workflowValueToDto({ domain: temperature }),
        topK: workflowValueToDto({ domain: topK }),
        topP: workflowValueToDto({ domain: topP }),
        seed: workflowValueToDto({ domain: seed }),
      },
      onLimit,
    });
  }
  case 'image_generation': {
    const { type, model, prompt, parameters, gpuBudgetMiB, imageInputs, preview, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    const { negativePrompt, width, height, steps, guidance, seed, sampler, scheduler, distilledGuidance, vaeTiling, vaeTileSize, flashAttention, bf16WeightType, qwenVaePolicy, conditioningCacheSize, modelArguments, profile, weightResidency, ...unhandledParameters } = parameters;
    unhandledParameters satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowStepDto, { type: typeof type }>>()({
      ...base,
      type,
      model: workflowValueToDto({ domain: model }),
      prompt: workflowValueToDto({ domain: prompt }),
      parameters: {
        negativePrompt: workflowValueToDto({ domain: negativePrompt }),
        width: workflowValueToDto({ domain: width }),
        height: workflowValueToDto({ domain: height }),
        steps: workflowValueToDto({ domain: steps }),
        guidance: workflowValueToDto({ domain: guidance }),
        seed: workflowValueToDto({ domain: seed }),
        sampler: workflowValueToDto({ domain: sampler }),
        scheduler: workflowValueToDto({ domain: scheduler }),
        distilledGuidance: workflowValueToDto({ domain: distilledGuidance }),
        vaeTiling: workflowValueToDto({ domain: vaeTiling }),
        vaeTileSize: workflowValueToDto({ domain: vaeTileSize }),
        flashAttention: workflowValueToDto({ domain: flashAttention }),
        bf16WeightType: workflowValueToDto({ domain: bf16WeightType }),
        qwenVaePolicy: workflowValueToDto({ domain: qwenVaePolicy }),
        conditioningCacheSize: workflowValueToDto({ domain: conditioningCacheSize }),
        modelArguments: workflowValueToDto({ domain: modelArguments }),
        profile: workflowValueToDto({ domain: profile }),
        weightResidency: workflowValueToDto({ domain: weightResidency }),
      },
      gpuBudgetMiB: gpuBudgetMiB === undefined ? undefined : workflowValueToDto({ domain: gpuBudgetMiB }),
      imageInputs: imageInputs === undefined ? undefined : (() => {
        const { initImage, referenceImages, strength, ...unhandled } = imageInputs;
        unhandled satisfies Record<PropertyKey, never>;
        return {
          initImage: initImage === undefined ? undefined : workflowValueToDto({ domain: initImage }),
          referenceImages: referenceImages.map(value => workflowValueToDto({ domain: value })),
          strength: workflowValueToDto({ domain: strength }),
        };
      })(),
      preview: preview === undefined ? undefined : (() => {
        const { enabled, interval, startStep, mode, maxEdge, ...unhandled } = preview;
        unhandled satisfies Record<PropertyKey, never>;
        return { enabled, interval, startStep, mode, maxEdge };
      })(),
    });
  }
  case 'tool_call': {
    const { type, tool, arguments: argumentsValue, onError, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    const selection = (() => {
      switch (tool.name) {
      case 'calculator': case 'wikipedia_search': case 'wikipedia_get_page': {
        const { name, ...rest } = tool;
        rest satisfies Record<PropertyKey, never>;
        return { name };
      }
      case 'shell_execute': {
        const { name, volumeId, access, ...rest } = tool;
        rest satisfies Record<PropertyKey, never>;
        return { name, volumeId: idToRaw({ id: volumeId }), access };
      }
      default: {
        const exhaustive: never = tool;
        throw new Error(String(exhaustive));
      }
      }
    })();
    return exactObject<Extract<ExperimentalWorkflowStepDto, { type: typeof type }>>()({ ...base, type, tool: selection, arguments: workflowValueToDto({ domain: argumentsValue }), onError });
  }
  case 'request_input': {
    const { type, prompt, responseType, choices, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowStepDto, { type: typeof type }>>()({ ...base, type, prompt: workflowValueToDto({ domain: prompt }), responseType, choices: choices === undefined ? undefined : workflowValueToDto({ domain: choices }) });
  }
  case 'repeat': {
    const { type, count, state, body: block, emit, stopWhen, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowStepDto, { type: typeof type }>>()({ ...base, type, count: workflowValueToDto({ domain: count }), state: workflowStateToDto({ state }), body: { steps: block.steps.map(step => workflowStepToDto({ domain: step })) }, emit: emit === undefined ? undefined : workflowValueToDto({ domain: emit }), stopWhen: stopWhen === undefined ? undefined : workflowValueToDto({ domain: stopWhen }) });
  }
  case 'for_each': {
    const { type, source, state, body: block, emit, stopWhen, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowStepDto, { type: typeof type }>>()({ ...base, type, source: workflowValueToDto({ domain: source }), state: workflowStateToDto({ state }), body: { steps: block.steps.map(step => workflowStepToDto({ domain: step })) }, emit: emit === undefined ? undefined : workflowValueToDto({ domain: emit }), stopWhen: stopWhen === undefined ? undefined : workflowValueToDto({ domain: stopWhen }) });
  }
  case 'if': {
    const { type, condition, then, else: otherwise, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowStepDto, { type: typeof type }>>()({ ...base, type, condition: workflowValueToDto({ domain: condition }), then: workflowBranchToDto({ branch: then }), else: workflowBranchToDto({ branch: otherwise }) });
  }
  case 'read_file': {
    const { type, volumeId, relativePath, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowStepDto, { type: typeof type }>>()({ ...base, type, volumeId: idToRaw({ id: volumeId }), relativePath: workflowValueToDto({ domain: relativePath }) });
  }
  case 'write_file': {
    const { type, volumeId, relativePath, source, format, onConflict, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowStepDto, { type: typeof type }>>()({ ...base, type, volumeId: idToRaw({ id: volumeId }), relativePath: workflowValueToDto({ domain: relativePath }), source: workflowValueToDto({ domain: source }), format, onConflict });
  }
  default: {
    const exhaustive: never = body;
    throw new Error(String(exhaustive));
  }
  }
}

export function workflowDefinitionToDto({ domain }: { domain: WorkflowDefinition }): ExperimentalWorkflowDefinitionDto {
  const { name, steps, executionLimits, ...unhandled } = domain;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<ExperimentalWorkflowDefinitionDto>()({ name, steps: steps.map(step => workflowStepToDto({ domain: step })), executionLimits: executionLimits === undefined ? undefined : copyExecutionLimits({ limits: executionLimits }) });
}

export function workflowDocumentToDto({ domain }: { domain: WorkflowDocument }): ExperimentalWorkflowDto {
  const { id, kind, createdAt, updatedAt, definition, ...unhandled } = domain;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<ExperimentalWorkflowDto>()({
    id: idToRaw({ id }),
    kind,
    createdAt,
    updatedAt,
    definition: workflowDefinitionToDto({ domain: definition }),
  });
}

export function workflowModelConfigurationToDomain({ dto }: { dto: ExperimentalWorkflowModelConfigurationDto }): WorkflowModelConfiguration {
  const { endpoint, modelId, lmParameters, ...unhandled } = dto;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<WorkflowModelConfiguration>()({ endpoint: endpointToDomain({ dto: endpoint }), modelId, lmParameters: lmParametersToDomain({ dto: lmParameters }) });
}

export function workflowModelConfigurationToDto({ domain }: { domain: WorkflowModelConfiguration }): ExperimentalWorkflowModelConfigurationDto {
  const { endpoint, modelId, lmParameters, ...unhandled } = domain;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<ExperimentalWorkflowModelConfigurationDto>()({ endpoint: endpointToDto({ endpoint }), modelId, lmParameters: lmParametersToDto({ domain: lmParameters }) });
}

export function workflowRunToDomain({ dto }: { dto: ExperimentalWorkflowRunDto }): WorkflowRunRecord {
  const { id, workflowId, definition, startedAt, finishedAt, status, ownership, checkpointAt, entries, error, resultsPath, resultError, ...unhandled } = dto;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<WorkflowRunRecord>()({
    id: toWorkflowRunId({ raw: id }),
    workflowId: workflowId === undefined ? undefined : toWorkflowId({ raw: workflowId }),
    definition: workflowDefinitionToDomain({ dto: definition }),
    startedAt,
    finishedAt,
    status,
    ownership,
    checkpointAt,
    error,
    resultError,
    resultsPath: resultsPath === undefined ? undefined : [...resultsPath],
    entries: entries.map(entry => {
      const { number, name, stepId, trace, phase, preview, inputPreview, ...unhandled } = entry;
      unhandled satisfies Record<PropertyKey, never>;
      return { number, name, stepId: toWorkflowStepId({ raw: stepId }), trace: [...trace], phase, preview, inputPreview };
    }),
  });
}

export function workflowRunToDto({ domain }: { domain: WorkflowRunRecord }): ExperimentalWorkflowRunDto {
  const { id, workflowId, definition, startedAt, finishedAt, status, ownership, checkpointAt, entries, error, resultsPath, resultError, ...unhandled } = domain;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<ExperimentalWorkflowRunDto>()({
    id: idToRaw({ id }),
    workflowId: workflowId === undefined ? undefined : idToRaw({ id: workflowId }),
    definition: workflowDefinitionToDto({ domain: definition }),
    startedAt,
    finishedAt,
    status,
    ownership,
    checkpointAt,
    error,
    resultError,
    resultsPath: resultsPath === undefined ? undefined : [...resultsPath],
    entries: entries.map(entry => {
      const { number, name, stepId, trace, phase, preview, inputPreview, ...unhandled } = entry;
      unhandled satisfies Record<PropertyKey, never>;
      return { number, name, stepId: idToRaw({ id: stepId }), trace: [...trace], phase, preview, inputPreview };
    }),
  });
}

export const TEST_ONLY = {
};
