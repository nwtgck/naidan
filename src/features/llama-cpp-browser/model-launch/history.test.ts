import { describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { toChatId, toChatGroupId } from '@/01-models/ids';
import { modelLaunchHistoryKey, readModelLaunchHistoryReservation, reserveModelLaunchHistory } from './history';
import { readModelLaunchReference } from './reference';
const chatId = toChatId({ raw: 'test-chat' });
const chatGroupId = toChatGroupId({ raw: 'test-group' });
const modelId = 'hf.co/owner/Model-GGUF:folder/Q4_K_M';

function reservation() {
  const history = createMemoryHistory();
  history.replace('/');
  reserveModelLaunchHistory({ history, location: '/', fallback: { chatId, newChatGroupId: chatGroupId } });
  return history;
}

describe('model launch retry reservation', () => {
  it('contains retry identifiers only without model input, revision, or a transfer plan', () => {
    const history = reservation();
    expect(Object.keys(history.state[modelLaunchHistoryKey] as object).sort()).toEqual(['chatGroupId', 'chatId', 'location', 'version']);
    expect(readModelLaunchHistoryReservation({ history, location: '/' })).toEqual({ chatId, newChatGroupId: chatGroupId });
    expect(readModelLaunchReference({ modelId })).toEqual({ modelId, repository: 'owner/Model-GGUF', variant: 'folder/Q4_K_M' });
  });

  it('does not reuse retry identifiers from a different entry location', () => {
    const history = reservation();
    expect(readModelLaunchHistoryReservation({ history, location: '/?llama-cpp-browser-model=other/repo' })).toBeUndefined();
    expect(readModelLaunchHistoryReservation({ history, location: '/?q=another-message' })).toBeUndefined();
  });

  it.each(['evil/Model-GGUF', 'https://evil.invalid/owner/Model-GGUF', 'https://user:password@huggingface.co/owner/Model-GGUF'])('rejects repository/origin payload outside the reservation contract: %s', input => {
    const history = reservation();
    history.replace('/', { [modelLaunchHistoryKey]: { ...(history.state[modelLaunchHistoryKey] as object), input } });
    expect(readModelLaunchHistoryReservation({ history, location: '/' })).toBeUndefined();
  });

  it('does not accept a full transfer plan hidden in a retry reservation', () => {
    const history = reservation();
    history.replace('/', { [modelLaunchHistoryKey]: { ...(history.state[modelLaunchHistoryKey] as object), selection: { files: [] } } });
    expect(readModelLaunchHistoryReservation({ history, location: '/' })).toBeUndefined();
  });

  it('preserves literal percent characters in a readable variant without decoding paths', () => {
    const literal = 'hf.co/owner/Model-GGUF:Q%20A';
    expect(readModelLaunchReference({ modelId: literal })).toEqual({ repository: 'owner/Model-GGUF', variant: 'Q%20A', modelId: literal });
  });

  it.each([undefined, 'owner/Model-GGUF:Q4_K_M', 'hf.co/owner/Model-GGUF:../bad', 'hf.co/owner/Model-GGUF:', 'hf.co/owner/Model-GGUF:folder//Model'])('rejects invalid public modelId %s', modelId => {
    expect(readModelLaunchReference({ modelId })).toBeUndefined();
  });
});
