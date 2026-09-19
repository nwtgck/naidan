// @vitest-environment node
import { expect, it } from 'vitest';
import { classifyFreshMetadataFailure } from './failure-category';

it('classifies built-in failures without copying their private payloads', () => {
  const message = '/Users/private-fixture/file.json?token=fixture-secret';
  expect(classifyFreshMetadataFailure({ error: new SyntaxError(message) })).toBe('syntax-error');
  expect(classifyFreshMetadataFailure({ error: new TypeError(message) })).toBe('type-error');
  expect(classifyFreshMetadataFailure({ error: new RangeError(message) })).toBe('range-error');
  expect(classifyFreshMetadataFailure({ error: new Error(message) })).toBe('error');
  expect(classifyFreshMetadataFailure({ error: message })).toBe('unknown');
});

it('does not read arbitrary error names, messages or causes to classify a failure', () => {
  const error = new Error();
  for (const key of ['name', 'message', 'stack', 'cause']) Object.defineProperty(error, key, { get() {
    throw new Error('A private error property was inspected');
  } });
  expect(classifyFreshMetadataFailure({ error })).toBe('error');
});

it('does not let an uninspectable thrown value hide partial evidence', () => {
  const error = new Proxy({}, { getPrototypeOf() {
    throw new Error('An uninspectable fixture value');
  } });
  expect(classifyFreshMetadataFailure({ error })).toBe('unknown');
});
