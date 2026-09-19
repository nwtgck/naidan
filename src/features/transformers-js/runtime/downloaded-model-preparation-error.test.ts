import { expect, it } from 'vitest';
import { downloadedModelPreparationError, withDownloadedModelPreparationPhase } from './downloaded-model-preparation-error';

it.each(['config', 'candidate-plan', 'tokenizer-processor'] as const)('records %s preparation failure without losing its original cause', async phase => {
  const cause = new Error('Original shared preparation failure');
  await expect(withDownloadedModelPreparationPhase({ phase, run: async () => {
    throw cause;
  } })).rejects.toMatchObject({
    name: 'DownloadedModelPreparationError', phase, cause,
    message: `Downloaded model preparation failed during ${phase}: Original shared preparation failure`,
  });
});

it.each([
  'MissingDownloadedModelArtifact', 'DownloadedModelResourcePlanningError',
  'RequiredDownloadedModelResourceError', 'RequiredDownloadedResourceCleanupError',
  'ProductionWorkerLifecycleError', 'DownloadedModelPreparationError',
  'TransformersJsOptionalConfigurationError',
])('preserves the existing %s identity instead of reclassifying it', name => {
  const cause = new Error('Existing classified failure');
  cause.name = name;
  expect(downloadedModelPreparationError({ phase: 'candidate-plan', cause })).toBe(cause);
});

it('does not infer recoverable missing artifacts from an untyped message', () => {
  const cause = new Error('Diagnostic mentions MissingDownloadedModelArtifact and MUST NOT fetch model artifacts');
  expect(downloadedModelPreparationError({ phase: 'config', cause })).toMatchObject({
    name: 'DownloadedModelPreparationError', phase: 'config', cause,
  });
});

it('retains non-Error thrown values as the cause', () => {
  expect(downloadedModelPreparationError({ phase: 'tokenizer-processor', cause: 42 })).toMatchObject({
    name: 'DownloadedModelPreparationError', phase: 'tokenizer-processor', cause: 42,
    message: 'Downloaded model preparation failed during tokenizer-processor: 42',
  });
});

it('returns successful preparation values unchanged', async () => {
  const value = { modelType: 'fixture' };
  await expect(withDownloadedModelPreparationPhase({ phase: 'config', run: async () => value })).resolves.toBe(value);
});
