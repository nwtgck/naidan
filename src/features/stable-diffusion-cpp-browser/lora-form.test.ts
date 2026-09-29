import { expect, it } from 'vitest';
import { imageLoraRequests, type ImageLoraSelection } from './lora-form';
import { createImageSessionKeys } from './session-key';
import { requestSchema } from './types';
import { ggufFile, requestFixture } from './test-fixtures';

it('omits explicitly disabled adapters before validation while preserving enabled zero strength and order', () => {
  const file = ggufFile();
  const selections: ImageLoraSelection[] = [
    { file, path: 'first.gguf', strength: 0.75, enabled: true },
    { file: new File([], 'unavailable.gguf'), strength: NaN, enabled: false },
    { file, path: 'zero.gguf', strength: 0, enabled: true },
    { file, path: 'last.gguf', strength: -0.5, enabled: true },
  ];
  const loras = imageLoraRequests({ selections });
  expect(loras).toEqual([
    { file, path: 'first.gguf', strength: 0.75 },
    { file, path: 'zero.gguf', strength: 0 },
    { file, path: 'last.gguf', strength: -0.5 },
  ]);
  expect(requestSchema.safeParse({ ...requestFixture(), loras }).success).toBe(true);
  expect(selections[1]).toMatchObject({ enabled: false, strength: NaN });
  selections[1]!.enabled = true;
  expect(requestSchema.safeParse({ ...requestFixture(), loras: imageLoraRequests({ selections }) }).success).toBe(false);
});

it('ignores disabled selection changes in the session key and replaces the context on explicit enable changes', () => {
  const keys = createImageSessionKeys();
  const request = requestFixture();
  const selections: ImageLoraSelection[] = [
    { file: ggufFile(), path: 'first.gguf', strength: 1, enabled: true },
    { file: ggufFile(), path: 'second.gguf', strength: 0.75, enabled: false },
  ];
  const key = () => keys.key({ request: { ...request, loras: imageLoraRequests({ selections }) } });
  const disabled = key();
  selections[1]!.file = ggufFile();
  selections[1]!.strength = -0.5;
  expect(key()).toBe(disabled);
  selections[1]!.enabled = true;
  const enabled = key();
  expect(enabled).not.toBe(disabled);
  selections[1]!.strength = 0;
  expect(key()).toBe(enabled);
  selections.reverse();
  expect(key()).not.toBe(enabled);
  selections.reverse();
  selections[1]!.enabled = false;
  expect(key()).toBe(disabled);
});
