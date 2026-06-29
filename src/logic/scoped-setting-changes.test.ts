import { describe, expect, it } from 'vitest';
import { toChatGroupId, toChatId } from '@/01-models/ids';
import type { Chat, ChatGroup, ChatMeta } from '@/01-models/types';
import {
  applyScopedSettingChangesToChat,
  applyScopedSettingChangesToChatGroup,
  applyScopedSettingChangesToChatMeta,
  cloneScopedSettingChanges,
  createChangedLmParameterSettingChanges,
  createLmParameterSettingChanges,
  normalizeLmParameters,
} from './scoped-setting-changes';

function createChatMeta(): ChatMeta {
  return {
    id: toChatId({ raw: 'chat-1' }),
    title: 'Chat',
    createdAt: 1,
    updatedAt: 2,
    debugEnabled: false,
    endpoint: {
      type: 'openai',
      url: 'https://example.test/v1',
      httpHeaders: [['Authorization', 'Bearer old']],
    },
    modelId: 'old-model',
    autoTitleEnabled: true,
    titleModelId: 'old-title-model',
    systemPrompt: {
      behavior: 'append',
      content: 'Old prompt',
    },
    lmParameters: {
      temperature: 0.5,
      topP: 0.8,
      maxCompletionTokens: 100,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      stop: ['OLD'],
      reasoning: { effort: 'low' },
    },
  };
}

function createChat(): Chat {
  return {
    ...createChatMeta(),
    root: { items: [] },
  };
}

function createChatGroup(): ChatGroup {
  return {
    id: toChatGroupId({ raw: 'group-1' }),
    name: 'Group',
    isCollapsed: false,
    items: [],
    updatedAt: 2,
    endpoint: {
      type: 'openai',
      url: 'https://example.test/v1',
    },
    modelId: 'old-model',
    lmParameters: {
      temperature: 0.5,
      topP: undefined,
      maxCompletionTokens: undefined,
      presencePenalty: undefined,
      frequencyPenalty: undefined,
      stop: undefined,
      reasoning: { effort: 'low' },
    },
  };
}

describe('scoped setting changes', () => {
  it('applies only explicitly listed fields to chat metadata', () => {
    const current = createChatMeta();

    const updated = applyScopedSettingChangesToChatMeta({
      current,
      changes: [
        {
          field: 'model_id',
          behavior: 'override',
          value: 'new-model',
        },
        {
          field: 'lm_param_temperature',
          behavior: 'override',
          value: 0.9,
        },
      ],
      updatedAt: 3,
    });

    expect(updated.modelId).toBe('new-model');
    expect(updated.lmParameters?.temperature).toBe(0.9);
    expect(updated.lmParameters?.reasoning.effort).toBe('low');
    expect(updated.endpoint).toEqual(current.endpoint);
    expect(updated.systemPrompt).toEqual(current.systemPrompt);
    expect(updated.updatedAt).toBe(3);
  });

  it('distinguishes inherited, cleared, replaced, and appended system prompts', () => {
    const current = createChatMeta();

    expect(applyScopedSettingChangesToChatMeta({
      current,
      changes: [{ field: 'system_prompt', behavior: 'inherit' }],
      updatedAt: 3,
    }).systemPrompt).toBeUndefined();

    expect(applyScopedSettingChangesToChatMeta({
      current,
      changes: [{ field: 'system_prompt', behavior: 'clear' }],
      updatedAt: 3,
    }).systemPrompt).toEqual({ behavior: 'override', content: null });

    expect(applyScopedSettingChangesToChatMeta({
      current,
      changes: [{ field: 'system_prompt', behavior: 'replace', content: 'Replacement' }],
      updatedAt: 3,
    }).systemPrompt).toEqual({ behavior: 'override', content: 'Replacement' });

    expect(applyScopedSettingChangesToChatMeta({
      current,
      changes: [{ field: 'system_prompt', behavior: 'append', content: 'Addition' }],
      updatedAt: 3,
    }).systemPrompt).toEqual({ behavior: 'append', content: 'Addition' });
  });

  it('clears one LM parameter without clearing unrelated parameters', () => {
    const updated = applyScopedSettingChangesToChatMeta({
      current: createChatMeta(),
      changes: [{ field: 'lm_param_temperature', behavior: 'inherit' }],
      updatedAt: 3,
    });

    expect(updated.lmParameters?.temperature).toBeUndefined();
    expect(updated.lmParameters?.topP).toBe(0.8);
    expect(updated.lmParameters?.reasoning.effort).toBe('low');
  });

  it('normalizes fully inherited LM parameters to undefined', () => {
    expect(normalizeLmParameters({
      lmParameters: {
        temperature: undefined,
        topP: undefined,
        maxCompletionTokens: undefined,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: { effort: undefined },
      },
    })).toBeUndefined();
  });

  it('replaces an HTTP endpoint with a transformers_js endpoint atomically', () => {
    const updated = applyScopedSettingChangesToChatMeta({
      current: createChatMeta(),
      changes: [{
        field: 'endpoint',
        behavior: 'override',
        value: { type: 'transformers_js' },
      }],
      updatedAt: 3,
    });

    expect(updated.endpoint).toEqual({ type: 'transformers_js' });
  });

  it('preserves and clones the Chat endpoint when another setting changes', () => {
    const current = createChat();
    const updated = applyScopedSettingChangesToChat({
      current,
      changes: [{ field: 'model_id', behavior: 'override', value: 'new-model' }],
      updatedAt: 3,
    });

    expect(updated.endpoint).toEqual(current.endpoint);
    expect(updated.endpoint).not.toBe(current.endpoint);
    if (updated.endpoint?.type !== 'openai' || current.endpoint?.type !== 'openai') {
      throw new Error('Expected OpenAI endpoints');
    }
    expect(updated.endpoint.httpHeaders).not.toBe(current.endpoint.httpHeaders);
  });

  it('preserves and clones the ChatMeta endpoint when another setting changes', () => {
    const current = createChatMeta();
    const updated = applyScopedSettingChangesToChatMeta({
      current,
      changes: [{ field: 'model_id', behavior: 'override', value: 'new-model' }],
      updatedAt: 3,
    });

    expect(updated.endpoint).toEqual(current.endpoint);
    expect(updated.endpoint).not.toBe(current.endpoint);
    if (updated.endpoint?.type !== 'openai' || current.endpoint?.type !== 'openai') {
      throw new Error('Expected OpenAI endpoints');
    }
    expect(updated.endpoint.httpHeaders).not.toBe(current.endpoint.httpHeaders);
  });

  it('applies atomic endpoint inheritance to Chat', () => {
    const current = createChat();
    const updated = applyScopedSettingChangesToChat({
      current,
      changes: [{ field: 'endpoint', behavior: 'inherit' }],
      updatedAt: 3,
    });

    expect(updated.endpoint).toBeUndefined();
    expect(updated.modelId).toBe(current.modelId);
  });

  it('applies the same change model to chat groups', () => {
    const current = createChatGroup();
    const updated = applyScopedSettingChangesToChatGroup({
      current,
      changes: [
        { field: 'model_id', behavior: 'inherit' },
        { field: 'lm_param_reasoning_effort', behavior: 'override', value: 'high' },
      ],
      updatedAt: 3,
    });

    expect(updated.modelId).toBeUndefined();
    expect(updated.lmParameters?.temperature).toBe(0.5);
    expect(updated.lmParameters?.reasoning.effort).toBe('high');
  });

  it('snapshots_nested_change_values_for_queued_updates', () => {
    const headers: [string, string][] = [['Authorization', 'Bearer old']];
    const stop = ['OLD'];
    const changes = cloneScopedSettingChanges({
      changes: [
        {
          field: 'endpoint',
          behavior: 'override',
          value: { type: 'openai', url: 'https://example.test/v1', httpHeaders: headers },
        },
        { field: 'lm_param_stop', behavior: 'override', value: stop },
      ],
    });

    headers[0]![1] = 'Bearer mutated';
    stop[0] = 'MUTATED';

    expect(changes).toEqual([
      {
        field: 'endpoint',
        behavior: 'override',
        value: { type: 'openai', url: 'https://example.test/v1', httpHeaders: [['Authorization', 'Bearer old']] },
      },
      { field: 'lm_param_stop', behavior: 'override', value: ['OLD'] },
    ]);
  });

  it('rejects duplicate fields in one batch', () => {
    expect(() => applyScopedSettingChangesToChatMeta({
      current: createChatMeta(),
      changes: [
        { field: 'model_id', behavior: 'inherit' },
        { field: 'model_id', behavior: 'override', value: 'new-model' },
      ],
      updatedAt: 3,
    })).toThrow('Duplicate scoped setting field: model_id');
  });

  it('creates_an_exhaustive_full_LM_parameter_replacement', () => {
    expect(createLmParameterSettingChanges({ lmParameters: undefined })).toEqual([
      { field: 'lm_param_temperature', behavior: 'inherit' },
      { field: 'lm_param_top_p', behavior: 'inherit' },
      { field: 'lm_param_max_completion_tokens', behavior: 'inherit' },
      { field: 'lm_param_presence_penalty', behavior: 'inherit' },
      { field: 'lm_param_frequency_penalty', behavior: 'inherit' },
      { field: 'lm_param_stop', behavior: 'inherit' },
      { field: 'lm_param_reasoning_effort', behavior: 'inherit' },
    ]);
  });

  it('creates_only_changed_LM_parameter_updates', () => {
    expect(createChangedLmParameterSettingChanges({
      previous: {
        temperature: 0.5,
        topP: undefined,
        maxCompletionTokens: undefined,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: ['OLD'],
        reasoning: { effort: 'low' },
      },
      next: {
        temperature: 0.8,
        topP: undefined,
        maxCompletionTokens: undefined,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: ['OLD'],
        reasoning: { effort: undefined },
      },
    })).toEqual([
      { field: 'lm_param_temperature', behavior: 'override', value: 0.8 },
      { field: 'lm_param_reasoning_effort', behavior: 'inherit' },
    ]);
  });

});
