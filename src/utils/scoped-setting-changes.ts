import type { LmParameterSettingChange, ScopedSettingChange } from '@/models/scoped-setting-change';
import type {
  Chat,
  ChatGroup,
  ChatMeta,
  Endpoint,
  LmParameters,
  SystemPrompt,
} from '@/models/types';
import { EMPTY_LM_PARAMETERS } from '@/models/types';
import {
  cloneLmParameters,
  LM_PARAMETER_KEYS,
  normalizeLmParameters,
  REASONING_PARAMETER_KEYS,
} from '@/utils/lm-parameters';

export { normalizeLmParameters };


export function createSystemPromptSettingChange({
  systemPrompt,
}: {
  systemPrompt: SystemPrompt | undefined,
}): ScopedSettingChange {
  if (systemPrompt === undefined) {
    return { field: 'system_prompt', behavior: 'inherit' };
  }

  switch (systemPrompt.behavior) {
  case 'override':
    return systemPrompt.content === null
      ? { field: 'system_prompt', behavior: 'clear' }
      : { field: 'system_prompt', behavior: 'replace', content: systemPrompt.content };
  case 'append':
    return { field: 'system_prompt', behavior: 'append', content: systemPrompt.content };
  default: {
    const _ex: never = systemPrompt;
    throw new Error(`Unhandled system prompt: ${String(_ex)}`);
  }
  }
}

export function createLmParameterSettingChanges({
  lmParameters,
}: {
  lmParameters: LmParameters | undefined,
}): LmParameterSettingChange[] {
  const current = lmParameters ?? EMPTY_LM_PARAMETERS;
  const changes: LmParameterSettingChange[] = [];

  // Iterate the canonical shape and keep the switch exhaustive. Adding an LM
  // parameter must fail typechecking here until its persistence behavior is
  // defined; a hand-written result array would silently omit the new field.
  for (const key of LM_PARAMETER_KEYS) {
    switch (key) {
    case 'temperature':
      changes.push(current.temperature === undefined
        ? { field: 'lm_param_temperature', behavior: 'inherit' }
        : { field: 'lm_param_temperature', behavior: 'override', value: current.temperature });
      break;
    case 'topP':
      changes.push(current.topP === undefined
        ? { field: 'lm_param_top_p', behavior: 'inherit' }
        : { field: 'lm_param_top_p', behavior: 'override', value: current.topP });
      break;
    case 'maxCompletionTokens':
      changes.push(current.maxCompletionTokens === undefined
        ? { field: 'lm_param_max_completion_tokens', behavior: 'inherit' }
        : {
          field: 'lm_param_max_completion_tokens',
          behavior: 'override',
          value: current.maxCompletionTokens,
        });
      break;
    case 'presencePenalty':
      changes.push(current.presencePenalty === undefined
        ? { field: 'lm_param_presence_penalty', behavior: 'inherit' }
        : {
          field: 'lm_param_presence_penalty',
          behavior: 'override',
          value: current.presencePenalty,
        });
      break;
    case 'frequencyPenalty':
      changes.push(current.frequencyPenalty === undefined
        ? { field: 'lm_param_frequency_penalty', behavior: 'inherit' }
        : {
          field: 'lm_param_frequency_penalty',
          behavior: 'override',
          value: current.frequencyPenalty,
        });
      break;
    case 'stop':
      changes.push(current.stop === undefined
        ? { field: 'lm_param_stop', behavior: 'inherit' }
        : { field: 'lm_param_stop', behavior: 'override', value: current.stop });
      break;
    case 'reasoning':
      for (const reasoningKey of REASONING_PARAMETER_KEYS) {
        switch (reasoningKey) {
        case 'effort':
          changes.push(current.reasoning.effort === undefined
            ? { field: 'lm_param_reasoning_effort', behavior: 'inherit' }
            : {
              field: 'lm_param_reasoning_effort',
              behavior: 'override',
              value: current.reasoning.effort,
            });
          break;
        default: {
          const _ex: never = reasoningKey;
          throw new Error(`Unhandled reasoning parameter key: ${_ex}`);
        }
        }
      }
      break;
    default: {
      const _ex: never = key;
      throw new Error(`Unhandled LM parameter key: ${_ex}`);
    }
    }
  }

  return changes;
}

function areStringArraysEqual({
  left,
  right,
}: {
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
}): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function createChangedLmParameterSettingChanges({
  previous,
  next,
}: {
  previous: LmParameters | undefined,
  next: LmParameters | undefined,
}): LmParameterSettingChange[] {
  const previousLmParameters = previous ?? EMPTY_LM_PARAMETERS;
  const nextLmParameters = next ?? EMPTY_LM_PARAMETERS;
  const changes: LmParameterSettingChange[] = [];

  // This mirrors createLmParameterSettingChanges deliberately: the key-driven
  // exhaustive switches make newly added top-level or reasoning parameters fail
  // typechecking until their change-detection semantics are implemented.
  for (const key of LM_PARAMETER_KEYS) {
    switch (key) {
    case 'temperature':
      if (previousLmParameters.temperature !== nextLmParameters.temperature) {
        changes.push(nextLmParameters.temperature === undefined
          ? { field: 'lm_param_temperature', behavior: 'inherit' }
          : { field: 'lm_param_temperature', behavior: 'override', value: nextLmParameters.temperature });
      }
      break;
    case 'topP':
      if (previousLmParameters.topP !== nextLmParameters.topP) {
        changes.push(nextLmParameters.topP === undefined
          ? { field: 'lm_param_top_p', behavior: 'inherit' }
          : { field: 'lm_param_top_p', behavior: 'override', value: nextLmParameters.topP });
      }
      break;
    case 'maxCompletionTokens':
      if (previousLmParameters.maxCompletionTokens !== nextLmParameters.maxCompletionTokens) {
        changes.push(nextLmParameters.maxCompletionTokens === undefined
          ? { field: 'lm_param_max_completion_tokens', behavior: 'inherit' }
          : {
            field: 'lm_param_max_completion_tokens',
            behavior: 'override',
            value: nextLmParameters.maxCompletionTokens,
          });
      }
      break;
    case 'presencePenalty':
      if (previousLmParameters.presencePenalty !== nextLmParameters.presencePenalty) {
        changes.push(nextLmParameters.presencePenalty === undefined
          ? { field: 'lm_param_presence_penalty', behavior: 'inherit' }
          : {
            field: 'lm_param_presence_penalty',
            behavior: 'override',
            value: nextLmParameters.presencePenalty,
          });
      }
      break;
    case 'frequencyPenalty':
      if (previousLmParameters.frequencyPenalty !== nextLmParameters.frequencyPenalty) {
        changes.push(nextLmParameters.frequencyPenalty === undefined
          ? { field: 'lm_param_frequency_penalty', behavior: 'inherit' }
          : {
            field: 'lm_param_frequency_penalty',
            behavior: 'override',
            value: nextLmParameters.frequencyPenalty,
          });
      }
      break;
    case 'stop':
      if (!areStringArraysEqual({ left: previousLmParameters.stop, right: nextLmParameters.stop })) {
        changes.push(nextLmParameters.stop === undefined
          ? { field: 'lm_param_stop', behavior: 'inherit' }
          : { field: 'lm_param_stop', behavior: 'override', value: nextLmParameters.stop });
      }
      break;
    case 'reasoning':
      for (const reasoningKey of REASONING_PARAMETER_KEYS) {
        switch (reasoningKey) {
        case 'effort':
          if (previousLmParameters.reasoning.effort !== nextLmParameters.reasoning.effort) {
            changes.push(nextLmParameters.reasoning.effort === undefined
              ? { field: 'lm_param_reasoning_effort', behavior: 'inherit' }
              : {
                field: 'lm_param_reasoning_effort',
                behavior: 'override',
                value: nextLmParameters.reasoning.effort,
              });
          }
          break;
        default: {
          const _ex: never = reasoningKey;
          throw new Error(`Unhandled reasoning parameter key: ${_ex}`);
        }
        }
      }
      break;
    default: {
      const _ex: never = key;
      throw new Error(`Unhandled LM parameter key: ${_ex}`);
    }
    }
  }

  return changes;
}

export function cloneScopedSettingChanges({
  changes,
}: {
  changes: readonly ScopedSettingChange[],
}): ScopedSettingChange[] {
  // Snapshot queued commands through an exhaustive switch. TypeScript readonly
  // modifiers do not prevent runtime mutation by a caller, and a new field must
  // fail typechecking here until its nested-value cloning needs are reviewed.
  return changes.map((change) => {
    switch (change.field) {
    case 'endpoint':
      switch (change.behavior) {
      case 'inherit':
        return { ...change };
      case 'override':
        return {
          ...change,
          value: {
            ...change.value,
            httpHeaders: change.value.httpHeaders?.map(([name, value]) => [name, value]),
          },
        };
      default: {
        const _ex: never = change;
        throw new Error(`Unhandled endpoint behavior: ${String(_ex)}`);
      }
      }
    case 'lm_param_stop':
      switch (change.behavior) {
      case 'inherit':
        return { ...change };
      case 'override':
        return { ...change, value: [...change.value] };
      default: {
        const _ex: never = change;
        throw new Error(`Unhandled stop behavior: ${String(_ex)}`);
      }
      }
    case 'model_id':
    case 'auto_title_enabled':
    case 'title_model_id':
    case 'system_prompt':
    case 'lm_param_temperature':
    case 'lm_param_top_p':
    case 'lm_param_max_completion_tokens':
    case 'lm_param_presence_penalty':
    case 'lm_param_frequency_penalty':
    case 'lm_param_reasoning_effort':
      return { ...change };
    default: {
      const _ex: never = change;
      throw new Error(`Unhandled scoped setting field: ${String(_ex)}`);
    }
    }
  });
}

function cloneEndpoint({ endpoint }: { endpoint: Endpoint }): Endpoint {
  return {
    type: endpoint.type,
    url: endpoint.url,
    httpHeaders: endpoint.httpHeaders?.map(([name, value]) => [name, value]),
  };
}

function normalizeEndpointOverride({ endpoint }: { endpoint: Endpoint }): Endpoint {
  switch (endpoint.type) {
  case 'openai':
  case 'ollama':
    return cloneEndpoint({ endpoint });
  case 'transformers_js':
    // Normalize only an explicit endpoint override. Unrelated setting changes
    // must preserve the existing stored endpoint byte-for-byte (apart from
    // defensive array cloning), including legacy states awaiting migration.
    return { type: 'transformers_js' };
  default: {
    const _ex: never = endpoint.type;
    throw new Error(`Unhandled endpoint type: ${_ex}`);
  }
  }
}

function assertUniqueFields({
  changes,
}: {
  changes: readonly ScopedSettingChange[],
}): void {
  const fields = new Set<ScopedSettingChange['field']>();
  for (const change of changes) {
    if (fields.has(change.field)) {
      throw new Error(`Duplicate scoped setting field: ${change.field}`);
    }
    fields.add(change.field);
  }
}

type ScopedSettingsState = {
  endpoint: Endpoint | undefined,
  modelId: string | undefined,
  autoTitleEnabled: boolean | undefined,
  titleModelId: string | undefined,
  systemPrompt: SystemPrompt | undefined,
  lmParameters: LmParameters | undefined,
};

function applyChanges({
  current,
  changes,
}: {
  current: ScopedSettingsState,
  changes: readonly ScopedSettingChange[],
}): ScopedSettingsState {
  assertUniqueFields({ changes });

  const next: ScopedSettingsState = {
    endpoint: current.endpoint === undefined
      ? undefined
      : cloneEndpoint({ endpoint: current.endpoint }),
    modelId: current.modelId,
    autoTitleEnabled: current.autoTitleEnabled,
    titleModelId: current.titleModelId,
    systemPrompt: current.systemPrompt === undefined
      ? undefined
      : { ...current.systemPrompt },
    lmParameters: current.lmParameters === undefined
      ? undefined
      : cloneLmParameters({ lmParameters: current.lmParameters }),
  };

  // The command union is applied through an exhaustive field/behavior switch.
  // Any new setting or behavior must fail typechecking until its persisted
  // state transition is defined; do not replace this with generic assignment.
  for (const change of changes) {
    switch (change.field) {
    case 'endpoint':
      switch (change.behavior) {
      case 'inherit':
        next.endpoint = undefined;
        break;
      case 'override':
        next.endpoint = normalizeEndpointOverride({ endpoint: change.value });
        break;
      default: {
        const _ex: never = change;
        throw new Error(`Unhandled endpoint behavior: ${String(_ex)}`);
      }
      }
      break;

    case 'model_id':
      switch (change.behavior) {
      case 'inherit':
        next.modelId = undefined;
        break;
      case 'override':
        next.modelId = change.value;
        break;
      default: {
        const _ex: never = change;
        throw new Error(`Unhandled model behavior: ${String(_ex)}`);
      }
      }
      break;

    case 'auto_title_enabled':
      switch (change.behavior) {
      case 'inherit':
        next.autoTitleEnabled = undefined;
        break;
      case 'override':
        next.autoTitleEnabled = change.value;
        break;
      default: {
        const _ex: never = change;
        throw new Error(`Unhandled auto title behavior: ${String(_ex)}`);
      }
      }
      break;

    case 'title_model_id':
      switch (change.behavior) {
      case 'inherit':
        next.titleModelId = undefined;
        break;
      case 'override':
        next.titleModelId = change.value;
        break;
      default: {
        const _ex: never = change;
        throw new Error(`Unhandled title model behavior: ${String(_ex)}`);
      }
      }
      break;

    case 'system_prompt':
      switch (change.behavior) {
      case 'inherit':
        next.systemPrompt = undefined;
        break;
      case 'clear':
        next.systemPrompt = {
          behavior: 'override',
          content: null,
        };
        break;
      case 'replace':
        next.systemPrompt = {
          behavior: 'override',
          content: change.content,
        };
        break;
      case 'append':
        next.systemPrompt = {
          behavior: 'append',
          content: change.content,
        };
        break;
      default: {
        const _ex: never = change;
        throw new Error(`Unhandled system prompt behavior: ${String(_ex)}`);
      }
      }
      break;

    case 'lm_param_temperature': {
      const lmParameters = cloneLmParameters({ lmParameters: next.lmParameters }) ?? {
        ...EMPTY_LM_PARAMETERS,
        reasoning: { ...EMPTY_LM_PARAMETERS.reasoning },
      };
      switch (change.behavior) {
      case 'inherit':
        lmParameters.temperature = undefined;
        break;
      case 'override':
        lmParameters.temperature = change.value;
        break;
      default: {
        const _ex: never = change;
        throw new Error(`Unhandled temperature behavior: ${String(_ex)}`);
      }
      }
      next.lmParameters = normalizeLmParameters({ lmParameters });
      break;
    }

    case 'lm_param_top_p': {
      const lmParameters = cloneLmParameters({ lmParameters: next.lmParameters }) ?? {
        ...EMPTY_LM_PARAMETERS,
        reasoning: { ...EMPTY_LM_PARAMETERS.reasoning },
      };
      switch (change.behavior) {
      case 'inherit':
        lmParameters.topP = undefined;
        break;
      case 'override':
        lmParameters.topP = change.value;
        break;
      default: {
        const _ex: never = change;
        throw new Error(`Unhandled top p behavior: ${String(_ex)}`);
      }
      }
      next.lmParameters = normalizeLmParameters({ lmParameters });
      break;
    }

    case 'lm_param_max_completion_tokens': {
      const lmParameters = cloneLmParameters({ lmParameters: next.lmParameters }) ?? {
        ...EMPTY_LM_PARAMETERS,
        reasoning: { ...EMPTY_LM_PARAMETERS.reasoning },
      };
      switch (change.behavior) {
      case 'inherit':
        lmParameters.maxCompletionTokens = undefined;
        break;
      case 'override':
        lmParameters.maxCompletionTokens = change.value;
        break;
      default: {
        const _ex: never = change;
        throw new Error(`Unhandled max completion tokens behavior: ${String(_ex)}`);
      }
      }
      next.lmParameters = normalizeLmParameters({ lmParameters });
      break;
    }

    case 'lm_param_presence_penalty': {
      const lmParameters = cloneLmParameters({ lmParameters: next.lmParameters }) ?? {
        ...EMPTY_LM_PARAMETERS,
        reasoning: { ...EMPTY_LM_PARAMETERS.reasoning },
      };
      switch (change.behavior) {
      case 'inherit':
        lmParameters.presencePenalty = undefined;
        break;
      case 'override':
        lmParameters.presencePenalty = change.value;
        break;
      default: {
        const _ex: never = change;
        throw new Error(`Unhandled presence penalty behavior: ${String(_ex)}`);
      }
      }
      next.lmParameters = normalizeLmParameters({ lmParameters });
      break;
    }

    case 'lm_param_frequency_penalty': {
      const lmParameters = cloneLmParameters({ lmParameters: next.lmParameters }) ?? {
        ...EMPTY_LM_PARAMETERS,
        reasoning: { ...EMPTY_LM_PARAMETERS.reasoning },
      };
      switch (change.behavior) {
      case 'inherit':
        lmParameters.frequencyPenalty = undefined;
        break;
      case 'override':
        lmParameters.frequencyPenalty = change.value;
        break;
      default: {
        const _ex: never = change;
        throw new Error(`Unhandled frequency penalty behavior: ${String(_ex)}`);
      }
      }
      next.lmParameters = normalizeLmParameters({ lmParameters });
      break;
    }

    case 'lm_param_stop': {
      const lmParameters = cloneLmParameters({ lmParameters: next.lmParameters }) ?? {
        ...EMPTY_LM_PARAMETERS,
        reasoning: { ...EMPTY_LM_PARAMETERS.reasoning },
      };
      switch (change.behavior) {
      case 'inherit':
        lmParameters.stop = undefined;
        break;
      case 'override':
        lmParameters.stop = [...change.value];
        break;
      default: {
        const _ex: never = change;
        throw new Error(`Unhandled stop behavior: ${String(_ex)}`);
      }
      }
      next.lmParameters = normalizeLmParameters({ lmParameters });
      break;
    }

    case 'lm_param_reasoning_effort': {
      const lmParameters = cloneLmParameters({ lmParameters: next.lmParameters }) ?? {
        ...EMPTY_LM_PARAMETERS,
        reasoning: { ...EMPTY_LM_PARAMETERS.reasoning },
      };
      switch (change.behavior) {
      case 'inherit':
        lmParameters.reasoning.effort = undefined;
        break;
      case 'override':
        lmParameters.reasoning.effort = change.value;
        break;
      default: {
        const _ex: never = change;
        throw new Error(`Unhandled reasoning effort behavior: ${String(_ex)}`);
      }
      }
      next.lmParameters = normalizeLmParameters({ lmParameters });
      break;
    }

    default: {
      const _ex: never = change;
      throw new Error(`Unhandled scoped setting field: ${String(_ex)}`);
    }
    }
  }

  return next;
}

export function applyScopedSettingChangesToChat({
  current,
  changes,
  updatedAt,
}: {
  current: Chat,
  changes: readonly ScopedSettingChange[],
  updatedAt: number,
}): Chat {
  if (changes.length === 0) return current;

  const next = applyChanges({
    current: {
      endpoint: current.endpointType === undefined
        ? undefined
        : {
          type: current.endpointType,
          url: current.endpointUrl,
          httpHeaders: current.endpointHttpHeaders,
        },
      modelId: current.modelId,
      autoTitleEnabled: current.autoTitleEnabled,
      titleModelId: current.titleModelId,
      systemPrompt: current.systemPrompt,
      lmParameters: current.lmParameters,
    },
    changes,
  });

  const updatesEndpoint = changes.some(change => change.field === 'endpoint');

  return {
    ...current,
    endpointType: updatesEndpoint ? next.endpoint?.type : current.endpointType,
    endpointUrl: updatesEndpoint ? next.endpoint?.url : current.endpointUrl,
    endpointHttpHeaders: updatesEndpoint
      ? next.endpoint?.httpHeaders
      : current.endpointHttpHeaders?.map(([name, value]) => [name, value]),
    modelId: next.modelId,
    autoTitleEnabled: next.autoTitleEnabled,
    titleModelId: next.titleModelId,
    systemPrompt: next.systemPrompt,
    lmParameters: next.lmParameters,
    updatedAt,
  };
}

export function applyScopedSettingChangesToChatMeta({
  current,
  changes,
  updatedAt,
}: {
  current: ChatMeta,
  changes: readonly ScopedSettingChange[],
  updatedAt: number,
}): ChatMeta {
  if (changes.length === 0) return current;

  const next = applyChanges({
    current: {
      endpoint: current.endpoint,
      modelId: current.modelId,
      autoTitleEnabled: current.autoTitleEnabled,
      titleModelId: current.titleModelId,
      systemPrompt: current.systemPrompt,
      lmParameters: current.lmParameters,
    },
    changes,
  });

  return {
    ...current,
    ...next,
    updatedAt,
  };
}

export function applyScopedSettingChangesToChatGroup({
  current,
  changes,
  updatedAt,
}: {
  current: ChatGroup,
  changes: readonly ScopedSettingChange[],
  updatedAt: number,
}): ChatGroup {
  if (changes.length === 0) return current;

  const next = applyChanges({
    current: {
      endpoint: current.endpoint,
      modelId: current.modelId,
      autoTitleEnabled: current.autoTitleEnabled,
      titleModelId: current.titleModelId,
      systemPrompt: current.systemPrompt,
      lmParameters: current.lmParameters,
    },
    changes,
  });

  return {
    ...current,
    ...next,
    updatedAt,
  };
}
