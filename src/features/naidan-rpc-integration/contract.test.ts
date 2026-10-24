import { expect, it } from 'vitest';
import { methodNames } from '@/features/naidan-rpc';
import { compile } from '@/features/naidan-rpc/schema';
import { modelIdSchema } from '@/features/llama-cpp-browser/types';
import {
  chatModelIdSchema,
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
  for (const unknown of ['getProvidedMethods', '*', 'image', 'imageFromFiles', 'downloadModel', '__proto__', 'constructor']) {
    expect(peerAllowedMethodsSchema.safeParse([unknown]).success).toBe(false);
  }
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

it('passes modelId strings without deciding whether their model is present', () => {
  expect(chatModelIdSchema.safeParse('hf.co/example/model:Q4_K_M').success).toBe(true);
  expect(chatModelIdSchema.parse('hf.co/example/model:../Q4')).toBe('hf.co/example/model:../Q4');
  expect(chatModelIdSchema.safeParse('user/local.gguf').success).toBe(true);
});

it.each(['imatrix/Q4_K_M', 'nested/custom:100%-日本語', 'literal%2F/Q4', 'model file.gguf'])('preserves the readable HF selector %s through listing and generation contracts', selector => {
  const modelId = `hf.co/owner/repo:${selector}`;
  expect(chatModelIdSchema.parse(modelId)).toBe(modelId);
  expect(naidanPeerContract.methods.generateChat.input.shape.modelId.parse(modelId)).toBe(modelId);
  const plan = compile({ schema: naidanPeerContract.methods.listChatModels.result, capabilitiesAllowed: true, callbacksAllowed: false });
  if (plan.node.kind !== 'capability' || plan.node.capability.kind !== 'stream') {
    throw new Error('Expected a model item stream');
  }
  expect(plan.node.capability.item.parse({ modelId })).toEqual({ modelId });
});

it.each(['nested%2fmodel.gguf', '%2E%2E%2Fmodel.gguf', '%00model.gguf', '%ZZ.gguf', '%E0%A4%A.gguf'])('accepts literal percent characters without decoding a public Host filename: %s', selector => {
  const modelId = `host/MyModels1/owner/repo:${selector}`;
  expect(chatModelIdSchema.parse(modelId)).toBe(modelId);
});

it.each([
  'host/MyModels1/owner/repo:model.gguf',
  'host/MyModels1/owner/repo:Q4_K_M',
  'host/MyModels1/owner/repo:model.bin',
  'host/MyModels1/owner/repo:nested/custom:100%',
  'host/MyModels1/owner/repo:literal%2F/custom%25',
  'host/MyModels1/owner/repo:UD-Q4_K_XL',
  'host/MyModels1-2/owner/repo:subdir/model.gguf',
  'host/%E3%83%A2%E3%83%87%E3%83%AB%20Folder/owner/repo:model file.gguf',
  'host/legacy-directory-id/owner/repo:model.gguf',
])('preserves a public Host selector without resolving its alias or inventory: %s', modelId => {
  expect(chatModelIdSchema.parse(modelId)).toBe(modelId);
  expect(naidanPeerContract.methods.generateChat.input.shape.modelId.parse(modelId)).toBe(modelId);
});

it.each(['subdir/model.gguf', 'Q4_K_M', 'model.bin'])('accepts a Host selector in the listChatModels item contract: %s', selector => {
  const plan = compile({ schema: naidanPeerContract.methods.listChatModels.result, capabilitiesAllowed: true, callbacksAllowed: false });
  if (plan.node.kind !== 'capability' || plan.node.capability.kind !== 'stream') {
    throw new Error('Expected a model item stream');
  }
  const item = { modelId: `host/MyModels1/owner/repo:${selector}` };
  expect(plan.node.capability.item.parse(item)).toEqual(item);
});

it('preserves a long Host modelId without a duplicate label in the catalog item', () => {
  const plan = compile({ schema: naidanPeerContract.methods.listChatModels.result, capabilitiesAllowed: true, callbacksAllowed: false });
  if (plan.node.kind !== 'capability' || plan.node.capability.kind !== 'stream') {
    throw new Error('Expected a model item stream');
  }
  const schema = plan.node.capability.item;
  const modelId = `host/${encodeURIComponent('模'.repeat(255))}/owner/repo:model.gguf`;
  const item = { modelId };
  expect(modelId.length).toBeGreaterThan(1024);
  expect(schema.parse(item)).toEqual(item);
  expect(schema.parse({ modelId, ref: modelId, label: modelId })).toEqual(item);
  expect(schema.safeParse({ ref: modelId, label: modelId }).success).toBe(false);
  expect(schema.safeParse({ modelId: 42 }).success).toBe(false);
  expect(schema.parse({ modelId: 'user/My:Model' })).toEqual({ modelId: 'user/My:Model' });
});

it.each([
  'host/MyModels1/owner/repo',
  'host/MyModels1/owner/repo:',
  'host/MyModels1/owner/repo:../model.gguf',
  'host/MyModels1/owner/repo:/model.gguf',
  'host/MyModels1/owner/repo:subdir//model.gguf',
  'host/MyModels1/owner/repo:subdir/./model.gguf',
  'host/MyModels1/owner/repo:\0model.gguf',
  'host/MyModels1/owner/repo:subdir\\model.gguf',
  'host/%4Dodels/owner/repo:model.gguf',
  'host/%ZZ/owner/repo:model.gguf',
  'host//owner/repo:model.gguf',
  'host/MyModels1/../repo:model.gguf',
])('passes a Host string unchanged for the serving resolver: %s', modelId => {
  expect(chatModelIdSchema.parse(modelId)).toBe(modelId);
});

it('passes arbitrary modelId strings without imposing source grammar or length limits', () => {
  const values = [
    '', 'm'.repeat(512), 'm'.repeat(513), 'x'.repeat(8192),
    'other/MyModels1/owner/repo:model.gguf', 'user/model%20file.gguf',
    `hf.co/owner/repo:${'日'.repeat(40)}/${'本'.repeat(40)}.gguf`,
    `host/${encodeURIComponent('模'.repeat(255))}/owner/repo:model.gguf`,
    'user/My:Model', 'user/literal%2F',
  ];
  for (const modelId of values) {
    expect(chatModelIdSchema.parse(modelId)).toBe(modelId);
    expect(naidanPeerContract.methods.generateChat.input.shape.modelId.parse(modelId)).toBe(modelId);
  }
});

it('does not throw while validating a malformed or oversized seed', () => {
  const value = { prompt: 'tree', negativePrompt: '', width: 256, height: 256, steps: 4, guidance: 1, seed: '42', sampler: 'auto', scheduler: 'auto', distilledGuidance: 3.5 };
  expect(peerImageParametersSchema.safeParse(value).success).toBe(true);
  for (const seed of ['x', '', '-1', '9'.repeat(100), '9223372036854775808']) {
    expect(peerImageParametersSchema.safeParse({ ...value, seed }).success).toBe(false);
  }
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

it.each([
  'temp/Model-GGUF',
  'temp/MyModels1-2/owner/repo:subdir%2Fmodel.gguf',
  'temp/variants:Q4.gguf',
  'temp/root:..%2Fmodel.gguf',
  'temp/root:dir/model.gguf',
  'temp/root:%ZZ',
  'temp/root:dir%2fmodel.gguf',
  'temp/root:日本語/a%2Fb:model',
])('preserves temporary model names as literal selectors in ordinary listing and generation contracts: %s', modelId => {
  // The public selector is not URL-decoded: encoded-looking text may be an
  // actual filename, and '/' may be an actual relative directory separator.
  expect(chatModelIdSchema.parse(modelId)).toBe(modelId);
  expect(naidanPeerContract.methods.generateChat.input.shape.modelId.parse(modelId)).toBe(modelId);
  const plan = compile({ schema: naidanPeerContract.methods.listChatModels.result, capabilitiesAllowed: true, callbacksAllowed: false });
  if (plan.node.kind !== 'capability' || plan.node.capability.kind !== 'stream') {
    throw new Error('Expected a model item stream');
  }
  expect(plan.node.capability.item.parse({ modelId })).toEqual({ modelId });
});

it.each([
  'temp/..',
  'temp/.hidden',
  'temp/root:..',
  'temp/root:../model.gguf',
  'temp/root:./model.gguf',
  'temp/root:dir/../model.gguf',
  'temp/root:dir/./model.gguf',
  'temp/root:/model.gguf',
  'temp/root:dir//model.gguf',
  'temp/root:dir\\model.gguf',
  'temp/root:dir/\0model.gguf',
  'temp/root/owner/repo',
  'temp/root/owner/repo:',
])('passes a temporary string unchanged for the serving resolver: %s', modelId => {
  expect(chatModelIdSchema.parse(modelId)).toBe(modelId);
  expect(naidanPeerContract.methods.generateChat.input.shape.modelId.parse(modelId)).toBe(modelId);
});

it('does not apply temporary-selector literal-percent rules to ordinary RPC file paths', () => {
  expect(relativeModelPathSchema.safeParse('dir/model.gguf').success).toBe(true);
  expect(relativeModelPathSchema.safeParse('a/%2e%2e/b').success).toBe(false);
  expect(relativeModelPathSchema.safeParse('a/%ZZ/b').success).toBe(false);
});

it.each(['temp/shared/owner/repository/subdir/model.gguf', 'temp/shared/dir/%ZZ.safetensors', 'temp/shared/..%2Fmodel.gguf'])('accepts a temporary image locator without URL decoding: %s', path => {
  const selection = { primary: { slot: 'diffusion', file: { location: { kind: 'temp', path } } }, components: [], loras: [] };
  expect(imageModelSelectionSchema.parse(selection)).toEqual(selection);
});

it.each(['temp/../model.gguf', 'temp/root/../model.gguf', 'temp/root//model.gguf', 'temp/root/./file', 'temp/root', '/temp/root/file', 'models/user/model.gguf'])('rejects malformed temporary image locations: %s', path => {
  expect(imageModelSelectionSchema.safeParse({ primary: { slot: 'model', file: { location: { kind: 'temp', path } } }, components: [], loras: [] }).success).toBe(false);
});

it('versions the application contract independently of transport framing', () => {
  expect(naidanPeerContract.name).toBe('naidan.peer.v2');
  expect(chatModelIdSchema).toBe(modelIdSchema);
});

it.each([undefined, 42, true, null, {}, []])('requires a string modelId at the structural boundary: %j', modelId => {
  expect(chatModelIdSchema.safeParse(modelId).success).toBe(false);
  expect(naidanPeerContract.methods.generateChat.input.shape.modelId.safeParse(modelId).success).toBe(false);
});

it('describes modelId as the only chat catalog field and required generation selection', () => {
  const [catalog, generate] = describePeerMethods({ names: ['listChatModels', 'generateChat'] });
  expect(catalog).toMatchObject({ result: { kind: 'stream', item: { properties: { modelId: { type: 'string' } }, required: ['modelId'] } } });
  if (catalog?.result.kind !== 'stream' || generate?.input.kind !== 'object') {
    throw new Error('Expected the catalog stream and generation input descriptors');
  }
  expect(catalog.result.item.properties).toEqual({ modelId: { type: 'string' } });
  expect(generate.input.required).toContain('modelId');
  expect(generate.input.properties).not.toHaveProperty('model');
});
