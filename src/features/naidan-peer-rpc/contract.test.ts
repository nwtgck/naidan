import { expect, it } from 'vitest';
import { methodNames } from '@/features/naidan-rpc';
import { chatModelReferenceSchema, imageModelSelectionSchema, naidanPeerContract, peerAllowedMethodsSchema, peerImageParametersSchema, relativeModelPathSchema } from './contract';
import type { NaidanPeerMethodName } from './contract';

it('derives a closed method vocabulary with a single explicit image entry', () => {
  expect(methodNames({ contract: naidanPeerContract })).toEqual(['listChatModels', 'generateChat', 'listImageModels', 'generateImage']);
  const names: readonly NaidanPeerMethodName[] = ['listChatModels', 'generateChat'];
  expect(peerAllowedMethodsSchema.parse(names)).toEqual(names);
  expect(peerAllowedMethodsSchema.safeParse(['generateImage', 'generateImage']).success).toBe(false);
  for (const unknown of ['*', 'image', 'imageFromFiles', 'downloadModel', '__proto__', 'constructor']) expect(peerAllowedMethodsSchema.safeParse([unknown]).success).toBe(false);
});
it.each(['../private', '/absolute', 'models//file', 'https://example.invalid/file', 'a/./b', 'a/%2e%2e/b', 'a\\b', 'a\0b'])('rejects unsafe model path %s', path => {
  expect(relativeModelPathSchema.safeParse(path).success).toBe(false);
});
it('accepts only local repository references, including a named quantization', () => {
  expect(chatModelReferenceSchema.safeParse('hf.co/example/model:Q4_K_M').success).toBe(true);
  expect(chatModelReferenceSchema.safeParse('hf.co/example/model:../Q4').success).toBe(false);
  expect(chatModelReferenceSchema.safeParse('user/local.gguf').success).toBe(true);
});
it('does not throw while validating a malformed or oversized seed', () => {
  const value = { prompt: 'tree', negativePrompt: '', width: 256, height: 256, steps: 4, guidance: 1, seed: '42', sampler: 'auto', scheduler: 'auto', distilledGuidance: 3.5 };
  expect(peerImageParametersSchema.safeParse(value).success).toBe(true);
  for (const seed of ['x', '', '-1', '9'.repeat(100), '9223372036854775808']) expect(peerImageParametersSchema.safeParse({ ...value, seed }).success).toBe(false);
  expect(peerImageParametersSchema.safeParse({ ...value, modelArguments: 'unknown=true' }).success).toBe(false);
});
it('rejects duplicate component roles and requires explicit construction', () => {
  const file = { location: { kind: 'opfs', path: 'models/test/vae.gguf' } };
  expect(imageModelSelectionSchema.safeParse({ primary: { slot: 'diffusion', file }, components: [{ slot: 'vae', file }, { slot: 'vae', file }], loras: [] }).success).toBe(false);
  expect(imageModelSelectionSchema.safeParse({ primary: { slot: 'model', file }, components: [], loras: [] }).success).toBe(true);
});

it('rejects every ASCII control character without rejecting ordinary Unicode paths', () => {
  for (const code of [...Array.from({ length: 32 }, (_, i) => i), 127]) {
    expect(relativeModelPathSchema.safeParse(`models/a${String.fromCharCode(code)}b.gguf`).success).toBe(false);
  }
  expect(relativeModelPathSchema.safeParse('models/風景 model/本体.gguf').success).toBe(true);
});
