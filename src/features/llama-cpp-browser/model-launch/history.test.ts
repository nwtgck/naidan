import { describe, expect, it } from 'vitest';
import { toChatId } from '@/01-models/ids';
import { modelLaunchViewState, readModelLaunchView } from './history';
import { readModelLaunchReference } from './reference';
const chatId = toChatId({ raw: 'test-chat' });
const modelId = 'hf.co/owner/Model-GGUF:folder/Q4_K_M';

function view() {
  return modelLaunchViewState({ chatId, input: 'hf.co/owner/Model-GGUF:Q4_K_M', modelId, revision: 'a'.repeat(40) });
}

describe('model launch navigation context', () => {
  it('contains only navigation identifiers and retains a fixed selector across reload', () => {
    const state = view();
    expect(Object.keys(state).sort()).toEqual(['chatId', 'input', 'modelId', 'revision', 'version']);
    expect(readModelLaunchView({ state, chatId, modelId })).toEqual(state);
    expect(readModelLaunchReference({ modelId })).toEqual({ modelId, repository: 'owner/Model-GGUF', variant: 'folder/Q4_K_M' });
  });

  it('cannot override another chat or another selected model', () => {
    expect(readModelLaunchView({ state: view(), chatId: toChatId({ raw: 'other' }), modelId })).toBeUndefined();
    expect(readModelLaunchView({ state: view(), chatId, modelId: 'hf.co/owner/Model-GGUF:other.gguf' })).toBeUndefined();
  });

  it.each(['evil/Model-GGUF', 'https://evil.invalid/owner/Model-GGUF', 'https://user:password@huggingface.co/owner/Model-GGUF'])('rejects an unrelated or unsafe origin %s', input => {
    expect(readModelLaunchView({ state: { ...view(), input }, chatId, modelId })).toBeUndefined();
  });

  it('does not accept a full transfer plan hidden in navigation state', () => {
    expect(readModelLaunchView({ state: { ...view(), selection: { files: [] } }, chatId, modelId })).toBeUndefined();
  });

  it('preserves literal percent characters in a readable variant without decoding paths', () => {
    const literal = 'hf.co/owner/Model-GGUF:Q%20A';
    expect(readModelLaunchReference({ modelId: literal })).toEqual({ repository: 'owner/Model-GGUF', variant: 'Q%20A', modelId: literal });
  });

  it.each([undefined, 'owner/Model-GGUF:Q4_K_M', 'hf.co/owner/Model-GGUF:../bad', 'hf.co/owner/Model-GGUF:', 'hf.co/owner/Model-GGUF:folder//Model'])('rejects invalid public modelId %s', modelId => {
    expect(readModelLaunchReference({ modelId })).toBeUndefined();
  });
});
