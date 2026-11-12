import { describe, expect, it } from 'vitest';
import { captureImageModelConfiguration, resolveImageCompositionDraft } from './draft';
import { compositionDraftFixture } from './draft.test-support';

describe('composition model configuration and inheritance', () => {
  it('inherits omitted settings, preserves explicit empty negative prompts and random/automatic choices', () => {
    const common = compositionDraftFixture();
    const base = structuredClone(common);
    const first = resolveImageCompositionDraft({ common, input: { prompt: 'first' }, slots: [] });
    const second = resolveImageCompositionDraft({ common, input: { prompt: 'second', negativePrompt: '', seed: null, steps: 'auto', guidance: 'auto', vaeTileSize: 'auto', width: 512, count: 3 }, slots: [] });
    expect(first.request.parameters).toEqual({ ...common.request.parameters, prompt: 'first' });
    expect(second.request.parameters).toMatchObject({ prompt: 'second', negativePrompt: '', width: 512 });
    expect(second.seedMode).toBe('random');
    expect([second.stepsPreference, second.guidancePreference, second.vaeTileSizePreference]).toEqual(['auto', 'auto', 'auto']);
    expect(second.request.parameters).not.toHaveProperty('count');
    expect(common).toEqual(base);
  });

  it('copies only models/LoRAs/runtime and their editor intent into a slot, never prompt/seed/image preferences', () => {
    const other = compositionDraftFixture();
    other.request.parameters.prompt = 'must not leak';
    other.request.parameters.width = 1024;
    other.request.models[0]!.file.name = 'other.gguf';
    const config = captureImageModelConfiguration({ draft: other });
    other.request.models[0]!.file.name = 'edited-after-assignment.gguf';
    const common = compositionDraftFixture();
    const result = resolveImageCompositionDraft({ common, input: { prompt: 'new', uiModelConfigurationSlot: 'style' }, slots: [{ name: 'style', configuration: config }] });
    expect(result.request.models[0]!.file.name).toBe('other.gguf');
    expect(result.request.parameters).toEqual({ ...common.request.parameters, prompt: 'new' });
    expect(result.request.imageInputs).toEqual(common.request.imageInputs);
    expect(result.request.preview).toEqual(common.request.preview);
    expect(config).not.toHaveProperty('seedMode');
    expect(config.request).not.toHaveProperty('parameters');
  });

  it('retains File capabilities in memory for assigned configurations', () => {
    const draft = compositionDraftFixture(), file = new File(['weight'], 'model.gguf');
    draft.modelFiles = [{ location: draft.request.models[0]!.file, file }];
    const captured = captureImageModelConfiguration({ draft });
    expect(captured.modelFiles[0]!.file).toBe(file);
    const resolved = resolveImageCompositionDraft({ common: draft, input: { prompt: 'cat', uiModelConfigurationSlot: 'one' }, slots: [{ name: 'one', configuration: captured }] });
    expect(resolved.modelFiles[0]!.file).toBe(file);
  });

  it('does not silently use the shared model for an unassigned slot', () => {
    expect(() => resolveImageCompositionDraft({ common: compositionDraftFixture(), input: { prompt: 'cat', uiModelConfigurationSlot: 'missing' }, slots: [] })).toThrow('missing');
  });
});

it('rejects explicit local-only controls for a remote model instead of silently dropping them', () => {
  const common = compositionDraftFixture();
  common.inferenceLocation = { kind: 'naidan_rpc', registration: undefined };
  expect(() => resolveImageCompositionDraft({ common, input: { prompt: 'remote', flashAttention: true }, slots: [] })).toThrow('flashAttention');
  expect(resolveImageCompositionDraft({ common, input: { prompt: 'remote', steps: 'auto', vaeTileSize: 64 }, slots: [] }).vaeTileSizePreference).toBe(64);
});
