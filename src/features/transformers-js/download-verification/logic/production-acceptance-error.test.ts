import { expect, it } from 'vitest';
import { classifyProductionAcceptanceError, productionAcceptanceFailureStatus, serializeProductionAcceptanceError } from './production-acceptance-error';

it('treats the transported Transformers.js optional configuration origin as terminal using its exact name', () => {
  const error = new Error('generation_config.json: SyntaxError: Unexpected end of JSON input');
  error.name = 'TransformersJsOptionalConfigurationError';
  expect(classifyProductionAcceptanceError({ error })).toBe('terminal');
  expect(productionAcceptanceFailureStatus({ error })).toBe('failed');
  expect(serializeProductionAcceptanceError({ error })).toEqual({
    name: 'TransformersJsOptionalConfigurationError', message: error.message,
  });
});

it('does not classify an ordinary SyntaxError by optional configuration wording in its message', () => {
  const error = new SyntaxError('Adapter diagnostic quotes TransformersJsOptionalConfigurationError');
  expect(classifyProductionAcceptanceError({ error })).toBe('runtime-rejected');
  expect(productionAcceptanceFailureStatus({ error })).toBe('rejected');
});

it('treats transported shared preparation failures as terminal without custom phase fields', () => {
  const error = new Error('Downloaded model preparation failed during tokenizer-processor: missing processor config');
  error.name = 'DownloadedModelPreparationError';
  expect(classifyProductionAcceptanceError({ error })).toBe('terminal');
  expect(productionAcceptanceFailureStatus({ error })).toBe('failed');
  expect(serializeProductionAcceptanceError({ error })).toEqual({
    name: 'DownloadedModelPreparationError',
    message: 'Downloaded model preparation failed during tokenizer-processor: missing processor config',
  });
});

it('keeps model runtime failures eligible for fallback even when their message quotes a preparation error name', () => {
  const error = new Error('Adapter diagnostic: DownloadedModelPreparationError');
  expect(classifyProductionAcceptanceError({ error })).toBe('runtime-rejected');
  expect(productionAcceptanceFailureStatus({ error })).toBe('rejected');
});
