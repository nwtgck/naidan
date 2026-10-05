// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { DEFAULT_SETTINGS, type BrowserImageGenerationSettings, type Settings } from '@/01-models/types';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { createImageForm } from './form';
import { useImagePreferences } from './use-image-preferences';
import { useImageLibrary } from './use-image-library';
import { scanImageRepositories } from './logic/model-candidates';
import type { LocalImageRepository } from './logic/repository-store';
import { ggufFixture, safetensorsFixture, zImageTensors, fluxVaeTensors, qwenTextTensors } from './test-utils/weights';

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
});
function repositories(): LocalImageRepository[] {
  const files = [
    ggufFixture({ name: 'z-image.gguf', tensors: zImageTensors, metadata: {}, extraBytes: 0 }).file,
    safetensorsFixture({ name: 'vae.safetensors', tensors: fluxVaeTensors }).file,
    ggufFixture({ name: 'text.gguf', tensors: qwenTextTensors({ width: 2560, layers: 36 }), metadata: { 'general.architecture': 'qwen3' }, extraBytes: 0 }).file,
    ggufFixture({ name: 'adapter.gguf', tensors: [], metadata: {}, extraBytes: 8 }).file,
  ];
  return files.map((file, index) => ({ id: `user/${index}`, name: `repo ${index}`, files: [{ path: file.name, file }] }));
}
function harness({ saved, initialized, entries }: { saved: BrowserImageGenerationSettings | undefined, initialized: boolean, entries: LocalImageRepository[] }) {
  const scope = effectScope(); scopes.push(scope);
  return scope.run(() => {
    const settings = ref<Settings>({ ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: '' }, experimental: { browserImageGeneration: saved, locale: 'en' } });
    const ready = ref(initialized), restoring = ref(false), seedMode = ref<'random' | 'fixed'>('random'), historyEnabled = ref(true);
    const form = createImageForm({ profile: 'webgpu-wasm32-asyncify' });
    const download = vi.fn(), onSelection = vi.fn(), restored = vi.fn(), failed = vi.fn();
    const list = vi.fn(async () => entries);
    const library = useImageLibrary({ blocked: () => restoring.value, downloadsBlocked: () => false, onSelection, dependencies: { list, scan: scanImageRepositories, import: vi.fn(), download } });
    const updateExperimental = vi.fn(async ({ updater }: { updater: ({ experimental }: { experimental: Settings['experimental'] }) => Settings['experimental'] }) => {
      settings.value = { ...settings.value, experimental: updater({ experimental: settings.value.experimental }) };
    });
    useImagePreferences({ settings, initialized: ready, updateExperimental, form, seedMode, historyEnabled, library, restoring, restored, failed });
    return { scope, settings, ready, form, seedMode, historyEnabled, library, restoring, restored, failed, updateExperimental, download, onSelection, list };
  })!;
}
async function settled(): Promise<void> {
  await nextTick(); await new Promise(resolve => setImmediate(resolve)); await nextTick();
}

it('hydrates once before saving and stores only approved preferences after explicit edits', async () => {
  const h = harness({ initialized: false, entries: [], saved: { width: 512, height: 768, seedMode: 'fixed', seed: '9007199254740993', debug: 'on', imageDownload: { format: 'webp', metadata: 'include' }, preview: { enabled: 'enabled', interval: 5 }, maxResults: 31, bf16WeightType: 'f16' } });
  await settled(); expect(h.updateExperimental).not.toHaveBeenCalled();
  h.ready.value = true; await settled();
  expect(h.form.parameters.value).toMatchObject({ width: 512, height: 768, seed: '9007199254740993', bf16WeightType: 'f16' });
  expect(h.form.debug.value).toBe('on');
  expect(h.seedMode.value).toBe('fixed'); expect(h.form.imageDownloadPreferences.value).toEqual({ format: 'webp', metadata: 'include' });
  expect(h.form.preview.value).toMatchObject({ enabled: true, interval: 5 }); expect(h.form.maxResults.value).toBe(31);
  expect(h.updateExperimental).not.toHaveBeenCalled();
  h.form.parameters.value.prompt = 'private draft'; h.form.parameters.value.negativePrompt = 'private negative'; h.form.parameters.value.steps = 49; h.form.parameters.value.guidance = 6;
  await settled(); expect(h.updateExperimental).not.toHaveBeenCalled();
  h.settings.value.experimental = { ...h.settings.value.experimental, locale: 'ja', hostModelDirectories: [{ id: toHostModelDirectoryId({ raw: 'root' }), name: 'models' }] };
  h.form.parameters.value.width = 1024; h.form.preview.value.mode = 'projection'; h.form.maxPreviews.value = 9; h.form.keepPreviews.value = false; h.form.debug.value = 'off';
  h.form.setImageDownloadPreferences({ preferences: { format: 'jpeg', metadata: 'omit' } });
  await settled();
  expect(h.settings.value.experimental).toMatchObject({ locale: 'ja', hostModelDirectories: [{ name: 'models' }], browserImageGeneration: { width: 1024, debug: 'off', preview: { mode: 'projection', interval: 5 }, keepPreviews: 'disabled', maxPreviews: 9, imageDownload: { format: 'jpeg', metadata: 'omit' } } });
  expect(JSON.stringify(h.settings.value.experimental?.browserImageGeneration)).not.toContain('private');
  const reopened = harness({ initialized: true, entries: [], saved: h.settings.value.experimental?.browserImageGeneration }); await settled();
  expect(reopened.form.parameters.value.width).toBe(1024); expect(reopened.form.parameters.value.prompt).toBe('');
  expect(reopened.form.debug.value).toBe('off');
  expect(reopened.form.imageDownloadPreferences.value).toEqual({ format: 'jpeg', metadata: 'omit' });
  expect(reopened.updateExperimental).not.toHaveBeenCalled();
});

it('defaults an older saved group without debug to off without saving on hydration', async () => {
  const h = harness({ initialized: true, entries: [], saved: { width: 512 } }); await settled();
  expect(h.form.debug.value).toBe('off');
  expect(h.form.parameters.value.width).toBe(512);
  expect(h.updateExperimental).not.toHaveBeenCalled();
  h.form.debug.value = 'on'; await settled();
  expect(h.settings.value.experimental?.browserImageGeneration?.debug).toBe('on');
  h.form.debug.value = 'off'; await settled();
  expect(h.settings.value.experimental?.browserImageGeneration).toMatchObject({ width: 512, debug: 'off' });
});

it('preserves the last valid numeric value while other fields are edited', async () => {
  const h = harness({ initialized: true, entries: [], saved: { width: 512, preview: { interval: 4 }, maxResults: 20 } }); await settled();
  h.form.parameters.value.width = Number.NaN; h.form.preview.value.interval = Number.NaN; h.form.maxResults.value = Number.NaN;
  h.form.parameters.value.height = 768; h.form.preview.value.enabled = true;
  await settled();
  expect(h.settings.value.experimental?.browserImageGeneration).toMatchObject({ width: 512, height: 768, preview: { interval: 4, enabled: 'enabled' }, maxResults: 20 });
  h.form.parameters.value.width = 1024; await settled();
  expect(h.settings.value.experimental?.browserImageGeneration?.width).toBe(1024);
});

it('reports a save failure and retries the failed patch with the next valid edit', async () => {
  const h = harness({ initialized: true, entries: [], saved: {} }); await settled();
  h.updateExperimental.mockRejectedValueOnce(new Error('disk full'));
  h.form.parameters.value.width = 512; await settled();
  expect(h.failed).toHaveBeenCalledWith({ error: expect.objectContaining({ message: 'disk full' }) });
  h.form.parameters.value.height = 768; await settled();
  expect(h.settings.value.experimental?.browserImageGeneration).toMatchObject({ width: 512, height: 768 });
  expect(h.updateExperimental).toHaveBeenCalledTimes(2);
});

it('restores exact host/OPFS locations, explicit component none and LoRA controls without applying a preset', async () => {
  const entries = repositories();
  entries[0]!.hostSource = { directoryId: 'chosen-root', directoryName: 'Chosen', repository: 'org/image' };
  const sameNamed = { ...entries[0]!, id: 'other', hostSource: { directoryId: 'other-root', directoryName: 'Other', repository: 'org/image' } };
  const saved: BrowserImageGenerationSettings = { modelSelection: {
    primary: { slot: 'diffusion', location: { kind: 'host', directoryId: toHostModelDirectoryId({ raw: 'chosen-root' }), path: 'org/image/z-image.gguf' } },
    components: [{ slot: 'vae', choice: { kind: 'none' } }, { slot: 'lm', choice: { kind: 'file', location: { kind: 'opfs', path: 'models/user/2/text.gguf' } } }],
    loras: [{ location: { kind: 'opfs', path: 'models/user/3/adapter.gguf' }, enabled: 'disabled', strength: 0.7 }],
  }, preview: { enabled: 'enabled', mode: 'projection' }, width: 768 };
  const h = harness({ initialized: true, saved, entries: [sameNamed, ...entries] });
  await vi.waitFor(() => expect(h.restoring.value).toBe(false)); await settled();
  expect(h.library.main.value).toContain('user/0');
  expect(h.library.components.value.find(item => item.slot === 'vae')?.selected).toBe('');
  expect(h.form.loras.value).toHaveLength(1); expect(h.form.loras.value[0]).toMatchObject({ enabled: false, strength: 0.7 });
  expect(h.library.captureModelSelection({ loras: h.form.loras.value })).toEqual(saved.modelSelection);
  expect(h.download).not.toHaveBeenCalled(); expect(h.onSelection).not.toHaveBeenCalled(); expect(h.updateExperimental).not.toHaveBeenCalled();
  h.form.loras.value = h.form.loras.value.map(lora => ({ ...lora, enabled: true })); await settled();
  expect(h.settings.value.experimental?.browserImageGeneration?.modelSelection?.loras[0]).toMatchObject({ enabled: 'enabled', strength: 0.7 });
});

it('retains a missing primary locator instead of selecting a different available model', async () => {
  const saved: BrowserImageGenerationSettings = { modelSelection: { primary: { slot: 'diffusion', location: { kind: 'opfs', path: 'models/missing/z-image.gguf' } }, components: [], loras: [] } };
  const h = harness({ initialized: true, saved, entries: repositories() });
  await vi.waitFor(() => expect(h.restoring.value).toBe(false)); await settled();
  expect(h.library.ready.value).toBe(false); expect(h.library.selectedModels()).toBeUndefined();
  expect(h.restored).toHaveBeenCalledWith({ missing: ['models/missing/z-image.gguf'], missingInactive: [] });
  h.form.parameters.value.width = 512; await settled();
  expect(h.settings.value.experimental?.browserImageGeneration?.modelSelection).toEqual(saved.modelSelection);
  await h.library.refresh(); expect(h.library.main.value).toBe(''); expect(h.onSelection).not.toHaveBeenCalled();
});

it('keeps an unavailable disabled adapter informational and preserves its locator on another preference edit', async () => {
  const seed = harness({ initialized: true, saved: undefined, entries: repositories() }); await settled(); await seed.library.refresh();
  const selection = seed.library.captureModelSelection({ loras: [] })!;
  selection.loras.push({ location: { kind: 'host', directoryId: toHostModelDirectoryId({ raw: 'missing-root' }), path: 'org/adapter/off.gguf' }, enabled: 'disabled', strength: 0.8 });
  const h = harness({ initialized: true, saved: { modelSelection: selection }, entries: repositories() });
  await vi.waitFor(() => expect(h.restoring.value).toBe(false)); await settled();
  expect(h.library.ready.value).toBe(true); expect(h.form.loras.value).toEqual([]);
  expect(h.restored).toHaveBeenCalledWith({ missing: [], missingInactive: ['org/adapter/off.gguf'] });
  expect(h.library.captureModelSelection({ loras: [] })?.loras).toEqual(selection.loras);
  h.form.parameters.value.width = 512; await settled();
  expect(h.settings.value.experimental?.browserImageGeneration?.modelSelection?.loras).toEqual(selection.loras);
});

it('preserves automatic components separately from explicit none and file choices', async () => {
  const h = harness({ initialized: true, saved: undefined, entries: repositories() }); await settled(); await h.library.refresh();
  const automatic = h.library.captureModelSelection({ loras: [] })!;
  expect(automatic.components).toEqual([]);
  const reopened = harness({ initialized: true, saved: { modelSelection: automatic }, entries: repositories() });
  await vi.waitFor(() => expect(reopened.restoring.value).toBe(false));
  expect(reopened.library.ready.value).toBe(true); expect(reopened.library.captureModelSelection({ loras: [] })?.components).toEqual([]);
  const vaeId = reopened.library.components.value.find(item => item.slot === 'vae')!.selected;
  reopened.library.chooseComponent({ slot: 'vae', id: '' });
  expect(reopened.library.captureModelSelection({ loras: [] })?.components).toEqual([{ slot: 'vae', choice: { kind: 'none' } }]);
  reopened.library.chooseComponent({ slot: 'vae', id: vaeId });
  expect(reopened.library.captureModelSelection({ loras: [] })?.components).toEqual([{ slot: 'vae', choice: { kind: 'file', location: { kind: 'opfs', path: 'models/user/1/vae.safetensors' } } }]);
});

it('keeps a saved adapter location across a fresh inventory File snapshot and persists subsequent edits', async () => {
  const entries = repositories();
  const h = harness({ initialized: true, saved: undefined, entries }); await settled(); await h.library.refresh();
  h.form.loras.value = [{ file: entries[3]!.files[0]!.file, strength: 0.4, enabled: true }]; await settled();
  expect(h.settings.value.experimental?.browserImageGeneration?.modelSelection?.loras).toHaveLength(1);
  h.list.mockResolvedValueOnce(repositories()); await h.library.refresh();
  h.form.loras.value = h.form.loras.value.map(lora => ({ ...lora, enabled: false, strength: 0.9 })); await settled();
  const saved = h.settings.value.experimental?.browserImageGeneration;
  expect(saved?.modelSelection?.loras[0]).toEqual({ location: { kind: 'opfs', path: 'models/user/3/adapter.gguf' }, enabled: 'disabled', strength: 0.9 });
  const reopened = harness({ initialized: true, saved, entries: repositories() });
  await vi.waitFor(() => expect(reopened.restoring.value).toBe(false));
  expect(reopened.form.loras.value[0]).toMatchObject({ enabled: false, strength: 0.9 });
  h.form.loras.value = [{ file: new File(['temporary'], 'adapter.gguf'), enabled: true, strength: 1 }]; h.form.parameters.value.width = 512; await settled();
  expect(h.settings.value.experimental?.browserImageGeneration?.modelSelection?.loras).toEqual(saved?.modelSelection?.loras);
});

it('retains a saved missing download root rather than persisting a default destination', async () => {
  const destination = { kind: 'host' as const, directoryId: toHostModelDirectoryId({ raw: 'not-registered' }) };
  const h = harness({ initialized: true, saved: { modelDownloadDestination: destination }, entries: [] }); await settled();
  expect(h.library.hostDirectories.destination.value).toBe('not-registered');
  h.form.parameters.value.width = 512; await settled();
  expect(h.settings.value.experimental?.browserImageGeneration?.modelDownloadDestination).toEqual(destination);
});

it('drains already accepted preference edits after leaving the workspace during a pending save', async () => {
  const h = harness({ initialized: true, entries: [], saved: {} }); await settled();
  const writing = Promise.withResolvers<void>();
  h.updateExperimental.mockImplementationOnce(async ({ updater }) => {
    await writing.promise;
    h.settings.value = { ...h.settings.value, experimental: updater({ experimental: h.settings.value.experimental }) };
  });
  h.form.parameters.value.width = 512; await settled();
  h.form.parameters.value.height = 768; await settled();
  h.scope.stop(); writing.resolve(); await settled();
  expect(h.settings.value.experimental?.browserImageGeneration).toMatchObject({ width: 512, height: 768 });
  const reopened = harness({ initialized: true, saved: h.settings.value.experimental?.browserImageGeneration, entries: [] }); await settled();
  expect(reopened.form.parameters.value).toMatchObject({ width: 512, height: 768 });
});
