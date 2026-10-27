import { expect, it } from 'vitest';
import { formatHuggingFaceModelId, hasLocalRepositoryReferencePrefix, localRepositoryReference, localRepositoryReferenceStorage, parseLocalRepositoryReference } from './llama-cpp-browser-model-id';

it.each([
  ['Chat-Q4.gguf', 'Q4'],
  ['Q4/Chat-Q4-00001-of-00002.gguf', 'Q4'],
  ['imatrix/Chat-Q4.gguf', 'imatrix/Q4'],
  ['Chat-Q A.gguf', 'Q A'],
  ['Chat-Q%20A.gguf', 'Q%20A'],
  ['.gguf', '.gguf'],
])('uses the same readable modelId before download for %s', (mainFilePath, variant) => {
  expect(formatHuggingFaceModelId({ repository: 'owner/Chat-GGUF', mainFilePath })).toBe(`hf.co/owner/Chat-GGUF:${variant}`);
});

it.each(['../model.gguf', '/model.gguf', 'a//b.gguf', 'a\\b.gguf', 'model.safetensors'])('rejects unsafe or unsupported remote model path %s', mainFilePath => {
  expect(() => formatHuggingFaceModelId({ repository: 'owner/Chat-GGUF', mainFilePath })).toThrow();
});

it.each(['pending', 'saved'] as const)('round-trips readable %s local references without including a File source identity', storage => {
  const reference = { storage, rootName: 'Repo-2', selector: 'imatrix/Q4_K_M' };
  const modelId = localRepositoryReference(reference);
  expect(modelId).toBe(`${storage === 'pending' ? '~user' : 'user'}/Repo-2/imatrix/Q4_K_M`);
  expect(parseLocalRepositoryReference({ modelId })).toEqual(reference);
  expect(localRepositoryReferenceStorage({ modelId })).toBe(storage);
  expect(hasLocalRepositoryReferencePrefix({ modelId, storage })).toBe(true);
  expect(hasLocalRepositoryReferencePrefix({ modelId, storage: undefined })).toBe(true);
  expect(parseLocalRepositoryReference({ modelId: localRepositoryReference({ storage, rootName: '日本語', selector: undefined }) })).toEqual({ storage, rootName: '日本語', selector: undefined });
});

it.each(['~user', '~userx', 'userx', 'userx/repo', 'temp/Repo:model', 'hf.co/owner/repo:Q4', 'host/root/owner/repo:Q4'])('does not route unrelated IDs through the local repository namespace: %s', modelId => {
  expect(localRepositoryReferenceStorage({ modelId })).toBeUndefined();
  expect(hasLocalRepositoryReferencePrefix({ modelId, storage: undefined })).toBe(false);
  expect(() => parseLocalRepositoryReference({ modelId })).toThrow();
});

it.each(['~user/', 'user/', '~user/.hidden/Q4', '~user/../Q4', 'user/Repo/', '~user/Repo/a//b', 'user/Repo/a/../b', 'user/Repo/a\\b'])('rejects malformed references after namespace routing: %s', modelId => {
  expect(hasLocalRepositoryReferencePrefix({ modelId, storage: undefined })).toBe(true);
  expect(() => parseLocalRepositoryReference({ modelId })).toThrow();
});

it('formats saved references from the actual destination name rather than substituting the pending prefix', () => {
  const pending = localRepositoryReference({ storage: 'pending', rootName: 'Repo', selector: 'Q4' });
  const saved = localRepositoryReference({ storage: 'saved', rootName: 'Repo-2', selector: 'Q4' });
  expect(pending).toBe('~user/Repo/Q4');
  expect(saved).toBe('user/Repo-2/Q4');
});
