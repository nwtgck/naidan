import { describe, expect, it } from 'vitest';
import type { LocalModel } from './types';
import { localModelChatGroupName } from './chat-group-name';

function model({ modelId }: { modelId: string }): LocalModel {
  return { modelId, size: 128, importedAt: 1 };
}

describe('local model chat-group names', () => {
  it.each([
    { modelId: 'hf.co/unsloth/Qwen3.5-4B-GGUF:Q4_K_M', expected: 'Qwen3.5-4B-GGUF:Q4_K_M' },
    { modelId: 'hf.co/owner/repo:UD-Q4_K_XL', expected: 'repo:UD-Q4_K_XL' },
    { modelId: 'hf.co/owner/repo:nested/My-GGUF-Model-imatrix-Q4_K_M', expected: 'My-GGUF-Model-imatrix-Q4_K_M' },
    { modelId: 'hf.co/owner/repo:Model-Q4_K_M-001-of-002', expected: 'repo:Model-Q4_K_M-001-of-002' },
    { modelId: 'hf.co/owner/repo:Model-00001-of-00002-Q4_K_M', expected: 'repo:Model-00001-of-00002-Q4_K_M' },
    { modelId: 'host/MyModels1/owner/Chat-GGUF:Q6_K', expected: 'Chat-GGUF:Q6_K' },
    { modelId: 'hf.co/owner/repo:Q%20A', expected: 'repo:Q%20A' },
    { modelId: 'hf.co/owner/repo:Q A', expected: 'repo:Q A' },
    { modelId: 'hf.co/owner/repo:%invalid', expected: 'repo:%invalid' },
    { modelId: 'user/MyModel-Q4_K_M-GGUF', expected: 'MyModel-Q4_K_M' },
    { modelId: 'user/My-GGUF-Model-UD-Q4_K_XL-GGUF', expected: 'My-GGUF-Model-UD-Q4_K_XL' },
    { modelId: 'user/My%20Model-Q4_K_M-GGUF', expected: 'My%20Model-Q4_K_M' },
    { modelId: 'user/Model-Q4_K_M-00001-of-00002-GGUF', expected: 'Model-Q4_K_M-00001-of-00002' },
    { modelId: 'user/Model.GGUF-GGUF', expected: 'Model.GGUF' },
    { modelId: 'user/Custom folder', expected: 'Custom folder' },
    { modelId: 'temp/MyModel-Q4_K_M-GGUF', expected: 'MyModel-Q4_K_M' },
    { modelId: 'temp/MyModels1/owner/repo:Q6_K', expected: 'repo:Q6_K' },
    { modelId: 'temp/MyModels1:Q4', expected: 'MyModels1:Q4' },
    { modelId: 'temp/MyModel:Format-GGUF', expected: 'MyModel:Format-GGUF' },
    { modelId: 'temp/MyModels1/owner/repo:Format-GGUF', expected: 'repo:Format-GGUF' },
    { modelId: 'user/-GGUF', expected: '-GGUF' },
    { modelId: '.gguf', expected: '.gguf' },
  ])('uses the readable selection for $modelId', ({ modelId, expected }) => {
    expect(localModelChatGroupName({ model: model({ modelId }) })).toBe(expected);
  });

  it('uses the same label for a linked model regardless of private file metadata', () => {
    const local: LocalModel = {
      ...model({ modelId: 'host/MyModels1/owner/Chat-GGUF:Q4_K_M' }),
      source: { kind: 'host', directoryId: 'root', directoryName: 'MyModels1', repository: 'owner/Chat-GGUF', primaryRelativePath: 'nested/Raw%20Model-Q4_K_M.gguf' },
    };
    expect(localModelChatGroupName({ model: local })).toBe('Chat-GGUF:Q4_K_M');
  });
});
