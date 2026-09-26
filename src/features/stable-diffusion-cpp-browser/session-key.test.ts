import { expect, it } from 'vitest';
import { createImageSessionKeys } from './session-key';
import { requestFixture } from './test-fixtures';
it('ignores per-image parameters and preview settings while keeping all context choices', () => {
  const keys = createImageSessionKeys(), request = requestFixture();
  const initial = keys.key({ request });
  request.parameters.prompt = 'new prompt'; request.parameters.negativePrompt = 'new negative';
  request.parameters.width = 512; request.parameters.height = 768; request.parameters.seed = '123';
  request.parameters.steps = 8; request.parameters.guidance = 6; request.parameters.sampler = 'heun';
  request.parameters.scheduler = 'karras'; request.parameters.vaeTileSize = 16; request.parameters.vaeTiling = false;
  request.parameters.qwenVaePolicy = 'native'; request.preview.enabled = true; request.preview.interval = 1; request.preview.mode = 'vae'; request.preview.maxEdge = 0;
  expect(keys.key({ request })).toBe(initial);
  for (const modify of [
    () => {
      request.parameters.flashAttention = true;
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
    const before = keys.key({ request }); modify(); expect(keys.key({ request })).not.toBe(before);
  }
});
it('never treats distinct manual files as equal by name, size and modified time', () => {
  const keys = createImageSessionKeys(), request = requestFixture(), first = keys.key({ request });
  const file = request.models[0]!.file;
  request.models[0]!.file = new File([file], file.name, { lastModified: file.lastModified });
  expect(keys.key({ request })).not.toBe(first);
});
it('accepts a stable published identity across refresh and invalidates its companions and revision', () => {
  const keys = createImageSessionKeys(), request = requestFixture();
  request.models[0]!.sourceId = 'reviewed-publication-with-all-companions';
  const first = keys.key({ request }), file = request.models[0]!.file;
  request.models[0]!.file = new File([file], file.name, { lastModified: file.lastModified });
  expect(keys.key({ request })).toBe(first);
  request.models[0]!.sourceId = 'changed-companion-receipt'; expect(keys.key({ request })).not.toBe(first);
});
it('invalidates on manual companion identity or path but does not depend on model order', () => {
  const keys = createImageSessionKeys(), request = requestFixture();
  request.models[0]!.companions = [{ path: 'part.bin', file: request.models[0]!.file }];
  const first = keys.key({ request });
  request.models[0]!.companions![0]!.file = new File(['other content'], 'part.bin');
  expect(keys.key({ request })).not.toBe(first);
  request.models.push({ slot: 'vae', file: request.models[0]!.file });
  const reordered = keys.key({ request }); request.models.reverse(); expect(keys.key({ request })).toBe(reordered);
});
