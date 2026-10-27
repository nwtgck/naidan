import { expect, it } from 'vitest';
import { hasTemporaryModelPathPrefix, parseTemporaryModelRootPath, temporaryModelFilePath, temporaryModelRootPath } from './temporary-model-files';

it('keeps File registry paths separate from public model IDs and preserves literal file names', () => {
  const rootPath = temporaryModelRootPath({ rootName: 'モデル-2' });
  expect(rootPath).toBe('temp/モデル-2');
  expect(parseTemporaryModelRootPath({ rootPath })).toEqual({ rootName: 'モデル-2' });
  expect(temporaryModelFilePath({ rootPath, relativePath: 'owner/repository/subdir/model:Q4%20.gguf' })).toBe('temp/モデル-2/owner/repository/subdir/model:Q4%20.gguf');
  expect(hasTemporaryModelPathPrefix({ path: rootPath })).toBe(true);
  expect(hasTemporaryModelPathPrefix({ path: '~user/モデル-2/Q4' })).toBe(false);
  expect(hasTemporaryModelPathPrefix({ path: 'user/モデル-2/Q4' })).toBe(false);
});

it.each(['', '.', '..', '.hidden', 'a/b', 'a:b', 'a\\b', 'a\0b', 'a\x7fb', '\ud800'])('rejects unrepresentable registry root names: %s', rootName => {
  expect(() => temporaryModelRootPath({ rootName })).toThrow();
});

it.each(['temp/', 'temp/a/b', '~user/a', 'user/a', 'temp/..'])('rejects malformed root paths without interpreting them as public references: %s', rootPath => {
  expect(() => parseTemporaryModelRootPath({ rootPath })).toThrow();
});

it.each(['', '/model.gguf', '../model.gguf', 'a/../model.gguf', 'a//model.gguf', 'a\\model.gguf'])('rejects paths that escape or ambiguously address the captured registry root: %s', relativePath => {
  expect(() => temporaryModelFilePath({ rootPath: 'temp/Repo', relativePath })).toThrow();
});
