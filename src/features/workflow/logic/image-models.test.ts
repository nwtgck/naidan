import { expect, it } from 'vitest';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { resolveWorkflowImageModels } from './image-models';
import { workflowImageModelSchema } from './image-model-schema';
import { imageCandidate, imageSelection } from './image-generation.test-support';

it('resolves an exact checkpoint and preserves shard File objects', () => {
  const primary = imageCandidate({ overrides: {} });
  const shard = { relativePath: 'part-2.gguf', file: new File([new Uint8Array(16)], 'part-2.gguf') };
  primary.files.push(shard);
  const result = resolveWorkflowImageModels({ selection: imageSelection(), inventory: { candidates: [primary], issues: [] } });
  expect(result.models).toHaveLength(1);
  expect(result.models[0]?.file).toBe(primary.files[0]!.file);
  expect(result.models[0]?.companions?.[0]?.file).toBe(shard.file);
  expect(result.loras).toEqual([]);
});

it('never invents an automatic optional component from newly discovered files', () => {
  const primary = imageCandidate({ overrides: {} });
  const vae = imageCandidate({ overrides: { candidateKey: 'vae', primaryRelativePath: 'vae.gguf', files: [{ relativePath: 'vae.gguf', file: new File([new Uint8Array(16)], 'vae.gguf') }], family: 'unknown', classes: ['vae-sd4'], roles: ['vae'] } });
  expect(resolveWorkflowImageModels({ selection: imageSelection(), inventory: { candidates: [primary, vae], issues: [] } }).models).toHaveLength(1);
  const selection = imageSelection();
  selection.components = [];
  expect(() => resolveWorkflowImageModels({ selection, inventory: { candidates: [primary, vae], issues: [] } })).toThrow('explicitly');
});

it('rejects missing, duplicate, ambiguous and incompatible primary selections', () => {
  const primary = imageCandidate({ overrides: {} });
  expect(() => resolveWorkflowImageModels({ selection: imageSelection(), inventory: { candidates: [], issues: [] } })).toThrow('unavailable');
  expect(() => resolveWorkflowImageModels({ selection: imageSelection(), inventory: { candidates: [primary, primary], issues: [] } })).toThrow('ambiguous');
  expect(() => resolveWorkflowImageModels({ selection: imageSelection(), inventory: { candidates: [{ ...primary, issue: 'Broken' }], issues: [] } })).toThrow('unavailable');
  expect(() => resolveWorkflowImageModels({ selection: imageSelection(), inventory: { candidates: [{ ...primary, family: 'unknown' }], issues: [] } })).toThrow('unknown family');
});

it('requires every external component for a diffusion model', () => {
  const primary = imageCandidate({ overrides: { family: 'z-image', roles: ['diffusion'] } });
  const selection = imageSelection();
  selection.primary.slot = 'diffusion';
  selection.components = [{ slot: 'vae', choice: { kind: 'none' } }, { slot: 'lm', choice: { kind: 'none' } }];
  expect(() => resolveWorkflowImageModels({ selection, inventory: { candidates: [primary], issues: [] } })).toThrow('required: vae');
});

it('uses the approved component instead of a same-named candidate in another repository', () => {
  const primary = imageCandidate({ overrides: {} });
  const vae = imageCandidate({ overrides: { candidateKey: 'vae', repositoryKey: 'user/decoder', family: 'unknown', roles: ['vae'], classes: ['vae-sd4'] } });
  const unrelated = { ...vae, candidateKey: 'other', repositoryKey: 'user/other' };
  const selection = imageSelection();
  selection.components = [{ slot: 'vae', choice: { kind: 'file', location: { kind: 'opfs', path: 'models/user/decoder/model.gguf' } } }];
  const result = resolveWorkflowImageModels({ selection, inventory: { candidates: [primary, unrelated, vae], issues: [] } });
  expect(result.models[1]?.file).toBe(vae.files[0]!.file);
  expect(() => resolveWorkflowImageModels({ selection, inventory: { candidates: [primary, unrelated], issues: [] } })).toThrow('unavailable');
  expect(() => resolveWorkflowImageModels({ selection, inventory: { candidates: [primary, { ...vae, classes: ['vae-flux16'] }], issues: [] } })).toThrow('incompatible');
});

it('cannot reinterpret a checkpoint as its own decoder', () => {
  const selection = imageSelection();
  selection.components = [{ slot: 'vae', choice: { kind: 'file', location: selection.primary.location } }];
  expect(() => resolveWorkflowImageModels({ selection, inventory: { candidates: [imageCandidate({ overrides: {} })], issues: [] } })).toThrow('incompatible');
});

it('includes enabled library LoRAs without resolving disabled missing adapters', () => {
  const lora = imageCandidate({ overrides: { candidateKey: 'lora', repositoryKey: 'user/adapter', family: 'unknown', classes: ['lora'], roles: [] } });
  const selection = imageSelection();
  selection.loras = [
    { location: { kind: 'opfs', path: 'models/user/adapter/model.gguf' }, enabled: 'enabled', strength: 0.7 },
    { location: { kind: 'opfs', path: 'models/missing/disabled.gguf' }, enabled: 'disabled', strength: 1 },
  ];
  const result = resolveWorkflowImageModels({ selection, inventory: { candidates: [imageCandidate({ overrides: {} }), lora], issues: [] } });
  expect(result.loras).toEqual([{ file: lora.files[0]!.file, relativePath: 'model.gguf', strength: 0.7 }]);
  selection.loras[1]!.enabled = 'enabled';
  expect(() => resolveWorkflowImageModels({ selection, inventory: { candidates: [imageCandidate({ overrides: {} }), lora], issues: [] } })).toThrow('unavailable');
});

it('rejects primary weights mislabelled as adapters', () => {
  const selection = imageSelection();
  selection.loras = [{ location: selection.primary.location, enabled: 'enabled', strength: 1 }];
  expect(() => resolveWorkflowImageModels({ selection, inventory: { candidates: [imageCandidate({ overrides: {} })], issues: [] } })).toThrow('LoRA');
});

it('does not equate host and application-local paths', () => {
  const selection = imageSelection();
  selection.primary.location = { kind: 'host', directoryId: toHostModelDirectoryId({ raw: 'host-one' }), path: 'user/example/model.gguf' };
  expect(() => resolveWorkflowImageModels({ selection, inventory: { candidates: [imageCandidate({ overrides: {} })], issues: [] } })).toThrow('unavailable');
});

it.each(['../escape', '/absolute', 'models/a/../b', 'models/a\\b', 'temp/a/model.gguf'])('rejects unsafe or misclassified application path %s', path => {
  const selection = imageSelection();
  selection.primary.location = { kind: 'opfs', path };
  expect(workflowImageModelSchema.safeParse(selection).success).toBe(false);
});

it('rejects duplicate component slots and non-finite adapter strengths', () => {
  const selection = imageSelection();
  selection.components.push(selection.components[0]!);
  expect(workflowImageModelSchema.safeParse(selection).success).toBe(false);
  selection.components.pop();
  selection.loras = [{ location: selection.primary.location, enabled: 'enabled', strength: Infinity }];
  expect(workflowImageModelSchema.safeParse(selection).success).toBe(false);
});

export const TEST_ONLY = {
};
