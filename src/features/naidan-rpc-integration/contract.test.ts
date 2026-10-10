import { expect, it } from 'vitest';
import { methodNames } from '@/features/naidan-rpc';
import { compile } from '@/features/naidan-rpc/schema';
import {
  chatModelReferenceSchema,
  describePeerMethods,
  imageCatalogItemSchema,
  imageModelSelectionSchema,
  naidanPeerContract,
  peerAllowedMethodsSchema,
  peerProvidedMethodsSchema,
  peerChatEventSchema,
  peerImageParametersSchema,
  relativeModelPathSchema,
} from './contract';
import type { NaidanPeerMethodName } from './contract';

it('derives a closed method vocabulary with a single explicit image entry', () => {
  expect(methodNames({ contract: naidanPeerContract })).toEqual(['getProvidedMethods', 'listChatModels', 'generateChat', 'listImageModels', 'generateImage']);
  const names: readonly NaidanPeerMethodName[] = ['listChatModels', 'generateChat'];
  expect(peerAllowedMethodsSchema.parse(names)).toEqual(names);
  expect(peerAllowedMethodsSchema.safeParse(['generateImage', 'generateImage']).success).toBe(false);
  for (const unknown of ['getProvidedMethods', '*', 'image', 'imageFromFiles', 'downloadModel', '__proto__', 'constructor']) expect(peerAllowedMethodsSchema.safeParse([unknown]).success).toBe(false);
});

it('advertises structural types from the contract while keeping grants closed', () => {
  const methods = describePeerMethods({ names: ['generateImage', 'listChatModels'] });
  expect(methods[0]).toMatchObject({ name: 'generateImage', result: { kind: 'object', properties: { image: { kind: 'byte-stream' }, events: { kind: 'stream' } } }, notifications: { progress: { type: 'object' } } });
  const future = { ...methods[1]!, name: 'futureMethod', metadata: { revision: 2 } };
  expect(peerProvidedMethodsSchema.safeParse({ status: 'ready', methods: [future] }).success).toBe(true);
  expect(peerAllowedMethodsSchema.safeParse(['futureMethod']).success).toBe(false);
  expect(peerProvidedMethodsSchema.safeParse({ status: 'checking', methods }).success).toBe(false);
  expect(peerProvidedMethodsSchema.safeParse({ status: 'ready', methods: [future, future] }).success).toBe(false);
});

it.each(['../private', '/absolute', 'models//file', 'https://example.invalid/file', 'a/./b', 'a/%2e%2e/b', 'a\\b', 'a\0b'])('rejects unsafe model path %s', path => {
  expect(relativeModelPathSchema.safeParse(path).success).toBe(false);
});

it('accepts only local repository references, including a named quantization', () => {
  expect(chatModelReferenceSchema.safeParse('hf.co/example/model:Q4_K_M').success).toBe(true);
  expect(chatModelReferenceSchema.safeParse('hf.co/example/model:../Q4').success).toBe(false);
  expect(chatModelReferenceSchema.safeParse('user/local.gguf').success).toBe(true);
});

it.each([
  'host/Models/owner/repo:model.gguf',
  'host/Models/owner/repo:Q4_K_M',
  'host/Models/owner/repo:model.bin',
  'host/Models/owner/repo:nested%2Fcustom%3A100%25',
  'host/Models/owner/repo:Q4_K_M%20(split-00002)',
  'host/Models-2/owner/repo:subdir%2Fmodel.gguf',
  'host/%E3%83%A2%E3%83%87%E3%83%AB%20Folder/owner/repo:model%20file.gguf',
  'host/legacy-directory-id/owner/repo:model.gguf',
])('preserves a public Host selector without resolving its alias or inventory: %s', ref => {
  expect(chatModelReferenceSchema.parse(ref)).toBe(ref);
  expect(naidanPeerContract.methods.generateChat.input.shape.model.parse(ref)).toBe(ref);
});

it.each(['subdir%2Fmodel.gguf', 'Q4_K_M', 'model.bin'])('accepts a Host selector in the listChatModels item contract: %s', selector => {
  const plan = compile({ schema: naidanPeerContract.methods.listChatModels.result, capabilitiesAllowed: true, callbacksAllowed: false });
  if (plan.node.kind !== 'capability' || plan.node.capability.kind !== 'stream') throw new Error('Expected a model item stream');
  const item = { ref: `host/Models/owner/repo:${selector}`, label: 'Model' };
  expect(plan.node.capability.item.parse(item)).toEqual(item);
});

it('preserves long Host aliases as both references and labels in the full model item contract', () => {
  const plan = compile({ schema: naidanPeerContract.methods.listChatModels.result, capabilitiesAllowed: true, callbacksAllowed: false });
  if (plan.node.kind !== 'capability' || plan.node.capability.kind !== 'stream') throw new Error('Expected a model item stream');
  const schema = plan.node.capability.item;
  const ref = `host/${encodeURIComponent('模'.repeat(255))}/owner/repo:model.gguf`;
  const item = { ref, label: ref };
  expect(ref.length).toBeGreaterThan(1024);
  expect(schema.parse(item)).toEqual(item);
  expect(schema.safeParse({ ref, label: 'M'.repeat(4096) }).success).toBe(true);
  expect(schema.safeParse({ ref, label: 'M'.repeat(4097) }).success).toBe(false);
  expect(schema.safeParse({ ref: 'user/model.gguf', label: 'M'.repeat(1024) }).success).toBe(true);
  expect(schema.safeParse({ ref: 'user/model.gguf', label: 'M'.repeat(1025) }).success).toBe(false);
});

it.each([
  'host/Models/owner/repo',
  'host/Models/owner/repo:',
  'host/Models/owner/repo:../model.gguf',
  'host/Models/owner/repo:%2E%2E%2Fmodel.gguf',
  'host/Models/owner/repo:subdir/model.gguf',
  'host/Models/owner/repo:subdir%2fmodel.gguf',
  'host/Models/owner/repo:%00model.gguf',
  'host/Models/owner/repo:%ZZ.gguf',
  'host/Models/owner/repo:%E0%A4%A.gguf',
  'host/%4Dodels/owner/repo:model.gguf',
  'host/%ZZ/owner/repo:model.gguf',
  'host//owner/repo:model.gguf',
  'host/Models/../repo:model.gguf',
])('rejects malformed, noncanonical, or incomplete Host reference %s', ref => {
  expect(chatModelReferenceSchema.safeParse(ref).success).toBe(false);
});

it('reserves the larger reference bound for Host models and preserves remote restrictions', () => {
  const suffix = '/owner/repo:model.gguf';
  const encodedAlias = `host/${encodeURIComponent('模'.repeat(255))}${suffix}`;
  expect(chatModelReferenceSchema.parse(encodedAlias)).toBe(encodedAlias);
  const atLimit = `host/${'M'.repeat(4096 - 'host/'.length - suffix.length)}${suffix}`;
  expect(chatModelReferenceSchema.parse(atLimit)).toBe(atLimit);
  expect(chatModelReferenceSchema.safeParse(atLimit.replace('host/', 'host/M')).success).toBe(false);
  expect(chatModelReferenceSchema.safeParse('m'.repeat(512)).success).toBe(true);
  expect(chatModelReferenceSchema.safeParse('m'.repeat(513)).success).toBe(false);
  for (const ref of ['other/Models/owner/repo:model.gguf', 'user/model%20file.gguf', 'hf.co/owner/repo:model%20file.gguf']) {
    expect(chatModelReferenceSchema.safeParse(ref).success).toBe(false);
  }
});

it('does not throw while validating a malformed or oversized seed', () => {
  const value = { prompt: 'tree', negativePrompt: '', width: 256, height: 256, steps: 4, guidance: 1, seed: '42', sampler: 'auto', scheduler: 'auto', distilledGuidance: 3.5 };
  expect(peerImageParametersSchema.safeParse(value).success).toBe(true);
  for (const seed of ['x', '', '-1', '9'.repeat(100), '9223372036854775808']) expect(peerImageParametersSchema.safeParse({ ...value, seed }).success).toBe(false);
  expect(peerImageParametersSchema.parse({ ...value, modelArguments: 'unknown=true' })).toEqual(value);
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

it('strips catalog extensions at every object boundary without changing known model references', () => {
  const file = {
    location: { kind: 'host', directoryId: 'models', path: 'vae.gguf', rootLabel: 'Model directory' },
    expected: { size: 1024, lastModified: 42, checksum: 'future-checksum' },
    downloadUrl: 'https://example.invalid/vae.gguf',
  };
  const value = imageCatalogItemSchema.parse({
    label: 'VAE',
    file,
    roles: ['vae'],
    facts: { family: 'vae', classes: ['vae'], format: 'gguf' },
    providerMetadata: { revision: 2 },
  });
  expect(value).toEqual({
    label: 'VAE',
    file: {
      location: { kind: 'host', directoryId: 'models', path: 'vae.gguf' },
      expected: { size: 1024, lastModified: 42 },
    },
    roles: ['vae'],
    facts: { family: 'vae', classes: ['vae'] },
  });
  expect(imageCatalogItemSchema.safeParse({ ...value, roles: ['downloadModel'] }).success).toBe(false);
  expect(imageCatalogItemSchema.safeParse({ ...value, file: { location: { kind: 'url', path: 'vae.gguf' } } }).success).toBe(false);
});

it('strips extensions in known chat events while rejecting missing fields and unknown event kinds', () => {
  expect(peerChatEventSchema.parse({
    type: 'tool_call_draft',
    index: 0,
    arguments: { offset: 0, text: '{}', encoding: 'utf-8' },
    elapsedSeconds: 1,
  })).toEqual({ type: 'tool_call_draft', index: 0, arguments: { offset: 0, text: '{}' } });
  expect(peerChatEventSchema.safeParse({ type: 'text', elapsedSeconds: 1 }).success).toBe(false);
  expect(peerChatEventSchema.safeParse({ type: 'new-event', text: 'hello' }).success).toBe(false);
});
