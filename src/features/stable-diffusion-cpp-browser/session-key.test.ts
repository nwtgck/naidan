import { expect, it } from 'vitest';
import { createImageSessionKeys } from './session-key';
import { requestFixture } from './test-fixtures';

it('ignores per-image parameters and preview settings while keeping all context choices', () => {
  const keys = createImageSessionKeys(), request = requestFixture();
  const initial = keys.key({ request });
  request.parameters.prompt = 'new prompt';
  request.parameters.negativePrompt = 'new negative';
  request.parameters.width = 512;
  request.parameters.height = 768;
  request.parameters.seed = '123';
  request.parameters.steps = 8;
  request.parameters.guidance = 6;
  request.parameters.sampler = 'heun';
  request.parameters.scheduler = 'karras';
  request.parameters.vaeTileSize = 16;
  request.parameters.vaeTiling = false;
  request.parameters.qwenVaePolicy = 'native';
  request.preview.enabled = true;
  request.preview.interval = 1;
  request.preview.mode = 'vae';
  request.preview.maxEdge = 0;
  expect(keys.key({ request })).toBe(initial);
  for (const modify of [
    () => {
      request.parameters.flashAttention = true;
    },
    () => {
      request.parameters.bf16WeightType = 'f16';
    },
    () => {
      request.parameters.conditioningCacheSize = 1;
    },
    () => {
      request.parameters.modelArguments = 'new';
    },
    () => {
      request.weightResidency = 'cpu';
    },
    () => {
      request.gpuBudgetMiB = 1024;
    },
    () => {
      request.debug = 'on';
    },
    () => {
      request.baseUrl = 'https://different.invalid/';
    },
    () => {
      request.artifact.schemaSha256 = '9'.repeat(64);
    },
  ]) {
    const before = keys.key({ request });
    modify();
    expect(keys.key({ request })).not.toBe(before);
  }
});

it('never treats distinct manual files as equal by name, size and modified time', () => {
  const keys = createImageSessionKeys(), request = requestFixture(), first = keys.key({ request });
  const file = request.models[0]!.file;
  request.models[0]!.file = new File([file], file.name, { lastModified: file.lastModified });
  expect(keys.key({ request })).not.toBe(first);
});

it('retains a session for LoRA strength changes but replaces it for changed adapter files or paths', () => {
  const keys = createImageSessionKeys(), request = requestFixture();
  const noAdapter = keys.key({ request });
  const file = request.models[0]!.file;
  request.loras = [{ file, relativePath: 'styles/adapter.gguf', strength: 1 }];
  const selected = keys.key({ request });
  expect(selected).not.toBe(noAdapter);
  request.loras[0]!.strength = 0.5;
  expect(keys.key({ request })).toBe(selected);
  request.loras[0]!.strength = 0;
  expect(keys.key({ request })).toBe(selected);
  request.loras[0]!.file = new File([file], file.name, { lastModified: file.lastModified });
  expect(keys.key({ request })).not.toBe(selected);
  request.loras[0]!.file = file;
  request.loras[0]!.relativePath = 'different/adapter.gguf';
  expect(keys.key({ request })).not.toBe(selected);
  request.loras = [];
  expect(keys.key({ request })).toBe(noAdapter);
});

it('reuses a published file group across refresh and invalidates its companions and revision', () => {
  const keys = createImageSessionKeys(), request = requestFixture();
  request.models[0]!.modelFilesReuseKey = 'reviewed-publication-with-all-companions';
  const first = keys.key({ request }), file = request.models[0]!.file;
  request.models[0]!.file = new File([file], file.name, { lastModified: file.lastModified });
  expect(keys.key({ request })).toBe(first);
  request.models[0]!.modelFilesReuseKey = 'changed-companion-receipt';
  expect(keys.key({ request })).not.toBe(first);
});

it('invalidates on manual companion identity or path but does not depend on model order', () => {
  const keys = createImageSessionKeys(), request = requestFixture();
  request.models[0]!.companions = [{ relativePath: 'part.bin', file: request.models[0]!.file }];
  const first = keys.key({ request });
  request.models[0]!.companions![0]!.file = new File(['other content'], 'part.bin');
  expect(keys.key({ request })).not.toBe(first);
  request.models.push({ slot: 'vae', file: request.models[0]!.file });
  const reordered = keys.key({ request });
  request.models.reverse();
  expect(keys.key({ request })).toBe(reordered);
});

it.each([
  { label: 'ASCII paths', paths: ['part-a.safetensors', 'part-b.safetensors'] },
  { label: 'distinct Unicode paths', paths: ['caf\u00e9.safetensors', 'cafe\u0301.safetensors'] },
])('retains manual companion groups across reorderings without mutating $label', ({ paths }) => {
  const keys = createImageSessionKeys(), request = requestFixture();
  const companions = paths.map(relativePath => ({ relativePath, file: new File([new Uint8Array(8)], relativePath) }));
  request.models[0]!.companions = companions;
  const expected = keys.key({ request });
  expect(request.models[0]!.companions).toEqual(companions);
  request.models[0]!.companions = [...companions].reverse();
  const reversed = request.models[0]!.companions.slice();
  expect(keys.key({ request })).toBe(expected);
  expect(request.models[0]!.companions).toEqual(reversed);
});

it.each(['association', 'path', 'addition', 'removal', 'identity'] as const)('preserves manual companion invalidation after canonical ordering: %s', change => {
  const keys = createImageSessionKeys(), request = requestFixture();
  const first = { relativePath: 'a.safetensors', file: new File([new Uint8Array(8)], 'same.safetensors', { lastModified: 1 }) };
  const second = { relativePath: 'b.safetensors', file: new File([new Uint8Array(8)], 'same.safetensors', { lastModified: 1 }) };
  request.models[0]!.companions = [second, first];
  const before = keys.key({ request });
  switch (change) {
  case 'association': request.models[0]!.companions = [{ ...first, file: second.file }, { ...second, file: first.file }];
    break;
  case 'path': request.models[0]!.companions = [{ ...first, relativePath: 'renamed.safetensors' }, second];
    break;
  case 'addition': request.models[0]!.companions = [first, second, { relativePath: 'c.safetensors', file: first.file }];
    break;
  case 'removal': request.models[0]!.companions = [first];
    break;
  case 'identity': request.models[0]!.companions = [{ ...first, file: new File([first.file], first.file.name, { lastModified: first.file.lastModified }) }, second];
    break;
  default: {
    const exhaustive: never = change;
    throw new Error(`Unknown companion change: ${exhaustive}`);
  }
  }
  expect(keys.key({ request })).not.toBe(before);
});

it('retains the model context for new input images, changed strength and removal', () => {
  const keys = createImageSessionKeys(), request = requestFixture();
  const before = keys.key({ request });
  const first = new File(['first'], 'same.png', { type: 'image/png' });
  request.imageInputs = { initImage: first, strength: 0.3, referenceImages: [first] };
  expect(keys.key({ request })).toBe(before);
  request.imageInputs = { initImage: undefined, strength: 0.8, referenceImages: [new File(['other'], 'same.png', { type: 'image/png' })] };
  expect(keys.key({ request })).toBe(before);
  request.imageInputs.referenceImages = [];
  expect(keys.key({ request })).toBe(before);
});
