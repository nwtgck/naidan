import { expect, it } from 'vitest';
import { isTemporaryModelReference, parseTemporaryModelReference, temporaryModelReference } from './temporary-model-reference';

it.each([
  { rootName: 'Repo', repository: undefined, selector: undefined },
  { rootName: 'Repo-2', repository: undefined, selector: 'subdir/model:Q4.gguf' },
  { rootName: 'Models', repository: 'owner/repository', selector: 'imatrix/Q4' },
])('preserves legacy temp references without migration: $rootName/$repository/$selector', reference => {
  const modelId = temporaryModelReference(reference);
  expect(modelId.startsWith('temp/')).toBe(true);
  expect(parseTemporaryModelReference({ modelId })).toEqual(reference);
  expect(isTemporaryModelReference({ modelId })).toBe(true);
});

it.each(['temp/Repo:', 'temp/Repo/owner', 'temp/Repo/owner/repository', 'temp/Repo/owner/repository/other:Q4', 'temp/Repo:../Q4', 'temp/Repo/:Q4', '~user/Repo/Q4', 'user/Repo/Q4'])('rejects invalid legacy references rather than guessing a public ID: %s', modelId => {
  expect(() => parseTemporaryModelReference({ modelId })).toThrow();
  expect(isTemporaryModelReference({ modelId })).toBe(false);
});
