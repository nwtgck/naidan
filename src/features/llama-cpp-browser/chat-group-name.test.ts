import { describe, expect, it } from 'vitest';
import { huggingFaceModelId } from '@/01-models/llama-cpp-browser-model-launch';
import { hostModelReference } from './runtime/model-destination-types';
import type { LocalModel } from './types';
import { localModelChatGroupName } from './chat-group-name';

function model({ id, name, source }: { id: string, name: string, source: LocalModel['source'] }): LocalModel {
  return { id, name, source, size: 128, importedAt: 1 };
}

describe('local model chat-group names', () => {
  it.each([
    { repository: 'unsloth/Qwen3.5-4B-GGUF', path: 'Qwen3.5-4B-Q4_K_M.gguf', expected: 'Qwen3.5-4B-Q4_K_M' },
    { repository: 'unsloth/Qwen3.5-4B-GGUF', path: 'UD-Q4_K_XL/Qwen3.5-4B-UD-Q4_K_XL.gguf', expected: 'Qwen3.5-4B-UD-Q4_K_XL' },
    { repository: 'bartowski/gemma-3-27b-it-GGUF', path: 'Q4_K_M/gemma-3-27b-it-Q4_K_M-00001-of-00002.gguf', expected: 'gemma-3-27b-it-Q4_K_M' },
    { repository: 'owner/repo', path: 'nested/My-GGUF-Model-imatrix-Q4_K_M.GGUF', expected: 'My-GGUF-Model-imatrix-Q4_K_M' },
    { repository: 'owner/repo', path: 'Model-Q4_K_M-001-of-002.gguf', expected: 'Model-Q4_K_M-001-of-002' },
    { repository: 'owner/repo', path: 'Model-00001-of-00002-Q4_K_M.gguf', expected: 'Model-00001-of-00002-Q4_K_M' },
    { repository: 'owner/repo', path: 'Model%20Literal-Q4_K_M.gguf', expected: 'Model%20Literal-Q4_K_M' },
  ])('uses the full canonical file stem for $path', ({ repository, path, expected }) => {
    const local = model({ id: huggingFaceModelId({ repository, modelPath: path }), name: `hf.co/${repository}:Q4_K_M`, source: undefined });
    expect(localModelChatGroupName({ model: local })).toBe(expected);
  });

  it('prefers the raw linked-folder path without decoding literal percent sequences', () => {
    const local = model({
      id: hostModelReference({ directoryId: 'root', repository: 'owner/repo', modelPath: 'Other-Q8_0.gguf' }),
      name: 'host/Models/owner/repo:Q4_K_M',
      source: { kind: 'host', directoryId: 'root', directoryName: 'Models', repository: 'owner/repo', path: 'nested/Raw%20Model-UD-Q4_K_XL-00001-of-00002.gguf' },
    });
    expect(localModelChatGroupName({ model: local })).toBe('Raw%20Model-UD-Q4_K_XL');
  });

  it('uses the encoded canonical host path when source metadata is absent', () => {
    const local = model({
      id: hostModelReference({ directoryId: 'root', repository: 'owner/repo', modelPath: 'nested/Full Model-Q6_K.gguf' }),
      name: 'host/Models/owner/repo:Q6_K',
      source: undefined,
    });
    expect(localModelChatGroupName({ model: local })).toBe('Full Model-Q6_K');
  });

  it.each([
    { name: 'user/MyModel-Q4_K_M-GGUF', expected: 'MyModel-Q4_K_M' },
    { name: 'user/My-GGUF-Model-UD-Q4_K_XL-GGUF', expected: 'My-GGUF-Model-UD-Q4_K_XL' },
    { name: 'user/My%20Model-Q4_K_M-GGUF', expected: 'My%20Model-Q4_K_M' },
    { name: 'user/Model-Q4_K_M-00001-of-00002-GGUF', expected: 'Model-Q4_K_M' },
    { name: 'user/Model.GGUF-GGUF', expected: 'Model.GGUF' },
    { name: 'user/Custom folder', expected: 'Custom folder' },
    { name: 'temp/MyModel-Q4_K_M-GGUF', expected: 'MyModel-Q4_K_M' },
    { name: 'temp/Models/owner/repo:nested%2FFull%20Model-Q6_K.gguf', expected: 'Full Model-Q6_K' },
    { name: 'temp/Models:Model-00001-of-00002.gguf', expected: 'Model' },
  ])('uses the raw manual import stem for $name', ({ name, expected }) => {
    expect(localModelChatGroupName({ model: model({ id: name, name, source: undefined }) })).toBe(expected);
  });

  it('falls back to the raw name basename when the encoded locator is malformed', () => {
    const local = model({ id: 'hf.co/owner/repo:%invalid', name: 'folder/Raw%20Model-Q4_K_M.gguf', source: undefined });
    expect(localModelChatGroupName({ model: local })).toBe('Raw%20Model-Q4_K_M');
  });

  it('uses the last name component for other model references and keeps a nonempty fallback', () => {
    expect(localModelChatGroupName({ model: model({ id: 'other', name: 'owner/repo/Model-Q8_0.gguf', source: undefined }) })).toBe('Model-Q8_0');
    expect(localModelChatGroupName({ model: model({ id: 'other', name: '.gguf', source: undefined }) })).toBe('.gguf');
  });
});
