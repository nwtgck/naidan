import { z } from 'zod';
import type { WorkflowValue, WorkflowMessage, WorkflowStep, WorkflowDefinition, WorkflowDocument, WorkflowLoopState, WorkflowBranch } from '@/01-models/workflow';
import { idToRaw, toWorkflowId, toWorkflowStepId, toVolumeId } from '@/01-models/ids';
import type { ExperimentalWorkflowValueDto, ExperimentalWorkflowMessageDto, ExperimentalWorkflowStepDto, ExperimentalWorkflowDefinitionDto, ExperimentalWorkflowDto } from '@/00-storage/00-dto/experimental-workflow.dto';
import type { SystemPrompt } from '@/01-models/types';
import type { SystemPromptDto } from '@/00-storage/00-dto/dto';
import { endpointToDomain, endpointToDto, lmParametersToDomain, lmParametersToDto, toolConfigToDomain, toolConfigToDto } from './mappers';
import { exactObject } from '@/utils/exact-object';

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
  case 'array': case 'concat': case 'path': {
    const { type, items, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, items: items.map(value => workflowValueToDomain({ dto: value })) });
  }
  case 'object': {
    const { type, properties, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, workflowValueToDomain({ dto: value })])) });
  }
  case 'get': {
    const { type, value, path, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, value: workflowValueToDomain({ dto: value }), path: [...path] });
  }
  case 'filename': case 'not_empty': {
    const { type, value, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, value: workflowValueToDomain({ dto: value }) });
  }
  case 'format_number': {
    const { type, value, minDigits, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowValue, { type: typeof type }>>()({ type, value: workflowValueToDomain({ dto: value }), minDigits });
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

export function workflowMessageToDomain({ dto }: { dto: ExperimentalWorkflowMessageDto }): WorkflowMessage {
  const { role, parts, ...unhandled } = dto;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<WorkflowMessage>()({
    role,
    parts: parts.map(part => {
      switch (part.type) {
      case 'text': {
        const { type, text, ...unhandled } = part;
        unhandled satisfies Record<PropertyKey, never>;
        return { type, text };
      }
      case 'value': {
        const { type, value, ...unhandled } = part;
        unhandled satisfies Record<PropertyKey, never>;
        return { type, value: workflowValueToDomain({ dto: value }) };
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
  case 'parse_json': {
    const { type, source, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowStep, { type: typeof type }>>()({ ...base, type, source: workflowValueToDomain({ dto: source }) });
  }
  case 'text_generation': {
    const { type, target, conversation, appendMessages, systemPrompt, lmParameters, toolConfigs, ...unhandled } = body;
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
    });
  }
  case 'request_input': {
    const { type, prompt, responseType, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowStep, { type: typeof type }>>()({ ...base, type, prompt: workflowValueToDomain({ dto: prompt }), responseType });
  }
  case 'repeat': {
    const { type, count, state, body: block, emit, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowStep, { type: typeof type }>>()({ ...base, type, count: workflowValueToDomain({ dto: count }), state: workflowStateToDomain({ state }), body: { steps: block.steps.map(step => workflowStepToDomain({ dto: step })) }, emit: emit === undefined ? undefined : workflowValueToDomain({ dto: emit }) });
  }
  case 'for_each': {
    const { type, source, state, body: block, emit, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<WorkflowStep, { type: typeof type }>>()({ ...base, type, source: workflowValueToDomain({ dto: source }), state: workflowStateToDomain({ state }), body: { steps: block.steps.map(step => workflowStepToDomain({ dto: step })) }, emit: emit === undefined ? undefined : workflowValueToDomain({ dto: emit }) });
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
  const { name, steps, ...unhandled } = dto;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<WorkflowDefinition>()({ name, steps: steps.map(step => workflowStepToDomain({ dto: step })) });
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
  case 'array': case 'concat': case 'path': {
    const { type, items, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, items: items.map(value => workflowValueToDto({ domain: value })) });
  }
  case 'object': {
    const { type, properties, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, workflowValueToDto({ domain: value })])) });
  }
  case 'get': {
    const { type, value, path, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, value: workflowValueToDto({ domain: value }), path: [...path] });
  }
  case 'filename': case 'not_empty': {
    const { type, value, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, value: workflowValueToDto({ domain: value }) });
  }
  case 'format_number': {
    const { type, value, minDigits, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowValueDto, { type: typeof type }>>()({ type, value: workflowValueToDto({ domain: value }), minDigits });
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
      case 'text': {
        const { type, text, ...unhandled } = part;
        unhandled satisfies Record<PropertyKey, never>;
        return { type, text };
      }
      case 'value': {
        const { type, value, ...unhandled } = part;
        unhandled satisfies Record<PropertyKey, never>;
        return { type, value: workflowValueToDto({ domain: value }) };
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
  case 'parse_json': {
    const { type, source, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowStepDto, { type: typeof type }>>()({ ...base, type, source: workflowValueToDto({ domain: source }) });
  }
  case 'text_generation': {
    const { type, target, conversation, appendMessages, systemPrompt, lmParameters, toolConfigs, ...unhandled } = body;
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
    });
  }
  case 'request_input': {
    const { type, prompt, responseType, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowStepDto, { type: typeof type }>>()({ ...base, type, prompt: workflowValueToDto({ domain: prompt }), responseType });
  }
  case 'repeat': {
    const { type, count, state, body: block, emit, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowStepDto, { type: typeof type }>>()({ ...base, type, count: workflowValueToDto({ domain: count }), state: workflowStateToDto({ state }), body: { steps: block.steps.map(step => workflowStepToDto({ domain: step })) }, emit: emit === undefined ? undefined : workflowValueToDto({ domain: emit }) });
  }
  case 'for_each': {
    const { type, source, state, body: block, emit, ...unhandled } = body;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalWorkflowStepDto, { type: typeof type }>>()({ ...base, type, source: workflowValueToDto({ domain: source }), state: workflowStateToDto({ state }), body: { steps: block.steps.map(step => workflowStepToDto({ domain: step })) }, emit: emit === undefined ? undefined : workflowValueToDto({ domain: emit }) });
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
  const { name, steps, ...unhandled } = domain;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<ExperimentalWorkflowDefinitionDto>()({ name, steps: steps.map(step => workflowStepToDto({ domain: step })) });
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

export const TEST_ONLY = {
};
