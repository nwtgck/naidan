import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageGenerationLab from './ImageGenerationLab.vue';
import ImageModelLibrary from './ImageModelLibrary.vue';
import { ggufFile } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import type { ModelInventory } from '@/features/stable-diffusion-cpp-browser/logic/model-candidates';
import { benchmarkManifest } from '@/features/stable-diffusion-cpp-browser/benchmark/archive';
vi.mock('../inventory-worker/client', () => ({ inspectImageInventory: (...args: unknown[]) => mocks.inspect(...args) }));
vi.mock('../capabilities', () => ({ initialProfile: () => 'webgpu-wasm32-asyncify', supportsJspi: () => false, supportsMemory64: () => false }));
const mocks = vi.hoisted(() => ({ create: vi.fn(), generate: vi.fn(), dispose: vi.fn(), release: vi.fn(), cancel: vi.fn(), inspect: vi.fn(), updatePreview: vi.fn() }));
vi.mock('@/features/stable-diffusion-cpp-browser/worker/client', () => ({ createImageClient: () => {
  mocks.create(); return { generate: mocks.generate, dispose: mocks.dispose, release: mocks.release, cancel: mocks.cancel, updatePreview: mocks.updatePreview };
} }));
vi.mock('virtual:stable-diffusion-cpp-browser/config', () => ({ default: {
  kind: 'available', sourceCommit: 'a'.repeat(40), artifacts: [{ profile: 'webgpu-wasm32-asyncify', modulePath: `stable-diffusion-cpp-runtime/${'a'.repeat(40)}/webgpu-wasm32-asyncify/core.mjs`, wasmPath: `stable-diffusion-cpp-runtime/${'a'.repeat(40)}/webgpu-wasm32-asyncify/core.wasm.gz`, helpersPath: `stable-diffusion-cpp-runtime/${'a'.repeat(40)}/examples/runtime/index.mjs`, schemaSha256: '1'.repeat(64), wasmBytes: 8, wasmSha256: '0'.repeat(64) }],
} }));
let wrapper: VueWrapper<InstanceType<typeof ImageGenerationLab>> | undefined;
const descriptor = Object.getOwnPropertyDescriptor(navigator, 'gpu');
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.resetAllMocks(); mocks.inspect.mockResolvedValue({ candidates: [], issues: [] }); vi.stubGlobal('isSecureContext', true); vi.stubGlobal('OffscreenCanvas', class {}); vi.stubGlobal('DecompressionStream', class {});
  Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true });
  let url = 0;
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = vi.fn(() => `blob:test-image-${++url}`); static override revokeObjectURL = vi.fn();
  });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (descriptor) Object.defineProperty(navigator, 'gpu', descriptor); else Reflect.deleteProperty(navigator, 'gpu');
});
it('opens without inference workers or model reads', async () => {
  wrapper = mount(ImageGenerationLab); await flushPromises();
  expect(wrapper.get('h1').text()).toBe('Image generation lab');
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
});
it('defaults to F32 and releases retained weights when BF16 conversion changes before the next request', async () => {
  mocks.generate.mockResolvedValue({ png: new Blob(['PNG'], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'fixture' });
  wrapper = mount(ImageGenerationLab); await flushPromises();
  wrapper.vm.TEST_ONLY.files.value = { model: ggufFile() };
  wrapper.vm.TEST_ONLY.parameters.value.prompt = 'a small tree';
  expect(wrapper.get('[data-testid="image-bf16-weight-type"]').element).toHaveProperty('value', 'f32');
  await wrapper.vm.TEST_ONLY.generate(); await flushPromises();
  expect(mocks.generate.mock.calls[0]?.[0].request.parameters.bf16WeightType).toBe('f32');
  expect(wrapper.vm.TEST_ONLY.modelResident.value).toBe(true);
  mocks.release.mockClear();
  await wrapper.get('[data-testid="image-bf16-weight-type"]').setValue('f16'); await flushPromises();
  expect(mocks.release).toHaveBeenCalledOnce();
  expect(wrapper.vm.TEST_ONLY.modelResident.value).toBe(false);
  await wrapper.vm.TEST_ONLY.generate(); await flushPromises();
  expect(mocks.generate.mock.calls[1]?.[0].request.parameters.bf16WeightType).toBe('f16');
});
it('snapshots LoRA files and strength, sends disabled adapters as zero, and clears selections when the base model changes', async () => {
  const first = Promise.withResolvers<{ png: Blob, width: number, height: number, modelVersion: string }>();
  mocks.generate.mockReturnValueOnce(first.promise);
  mocks.generate.mockResolvedValue({ png: new Blob(['PNG']), width: 256, height: 256, modelVersion: 'fixture' });
  wrapper = mount(ImageGenerationLab); await flushPromises();
  const view = wrapper.vm.TEST_ONLY;
  view.files.value = { model: ggufFile() }; view.parameters.value.prompt = 'a small tree';
  const file = new File(['adapter fixture'], 'style.safetensors');
  view.loras.value = [{ file, strength: 0.75, enabled: true }];
  const task = view.generate(); await flushPromises();
  expect(wrapper.get('[data-testid="image-lora-files"]').element.matches(':disabled')).toBe(true);
  const request = mocks.generate.mock.calls[0]![0].request;
  view.loras.value[0]!.strength = 2;
  expect(request.loras).toEqual([{ file, strength: 0.75 }]);
  expect(request.loras[0].file).toBe(file);
  first.resolve({ png: new Blob(['PNG']), width: 256, height: 256, modelVersion: 'fixture' });
  await task; await flushPromises();
  await wrapper.get('[data-testid="image-lora-enabled"]').setValue(false);
  await view.generate();
  expect(mocks.generate.mock.calls[1]![0].request.loras).toEqual([{ file, strength: 0 }]);
  view.files.value = { model: ggufFile() };
  expect(view.loras.value).toEqual([]);
  await view.generate();
  expect(mocks.generate.mock.calls[2]![0].request.loras).toEqual([]);
});
it('rejects an invalid active LoRA strength before creating a client', async () => {
  wrapper = mount(ImageGenerationLab); await flushPromises();
  const view = wrapper.vm.TEST_ONLY;
  view.files.value = { model: ggufFile() }; view.parameters.value.prompt = 'test';
  view.loras.value = [{ file: new File(['adapter fixture'], 'style.gguf'), strength: NaN, enabled: true }];
  await view.generate();
  expect(mocks.create).not.toHaveBeenCalled();
});
it('clears ordinary LoRA selections when choosing another model from the library', async () => {
  mocks.inspect.mockResolvedValue(benchmarkInventory());
  wrapper = mount(ImageGenerationLab); await flushPromises();
  const library = wrapper.getComponent(ImageModelLibrary).props('view');
  const next = library.models.value.find(model => model.id !== library.main.value);
  expect(next).toBeDefined();
  wrapper.vm.TEST_ONLY.loras.value = [{ file: new File(['adapter fixture'], 'style.gguf'), strength: 1, enabled: true }];
  library.chooseMain({ id: next!.id });
  expect(wrapper.vm.TEST_ONLY.loras.value).toEqual([]);
});
it('shows unavailable controls rather than initializing another backend', async () => {
  Reflect.deleteProperty(navigator, 'gpu'); wrapper = mount(ImageGenerationLab); await flushPromises();
  expect(wrapper.get('[data-testid="image-generate"]').attributes('disabled')).toBeDefined();
  expect(wrapper.get('[data-testid="image-unavailable"]').text()).toContain('WebGPU'); expect(mocks.create).not.toHaveBeenCalled();
});
it('uses independent requests, saves a temporary result, and revokes it on unmount', async () => {
  mocks.generate.mockResolvedValue({ png: new Blob(['mock PNG'], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'mocked model' });
  wrapper = mount(ImageGenerationLab);
  wrapper.vm.TEST_ONLY.files.value = { model: ggufFile() };
  wrapper.vm.TEST_ONLY.parameters.value.prompt = 'a small tree';
  await wrapper.vm.TEST_ONLY.generate(); await flushPromises();
  expect(mocks.generate).toHaveBeenCalledTimes(1); expect(wrapper.findAll('[data-testid="image-generated-result"]')).toHaveLength(1);
  expect(wrapper.get('[data-testid="image-generated-result"] a[download]').attributes('download')).toBe('naidan-image-42.png');
  expect(mocks.generate.mock.calls[0]?.[0]?.request.weightResidency).toBe('auto');
  expect(mocks.generate.mock.calls[0]?.[0]?.request.gpuBudgetMiB).toBeUndefined();
  wrapper.unmount(); wrapper = undefined; expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-image-1');
});

it('keeps an optional empty budget in advanced settings and the catalog outside the model fieldset', async () => {
  wrapper = mount(ImageGenerationLab); await flushPromises();
  const memory = wrapper.get('[data-testid="image-memory-budget"]');
  expect(memory.element.closest('details')?.hasAttribute('open')).toBe(false);
  expect(memory.element.closest('details')?.textContent).toContain('Leave empty');
  expect(memory.attributes('required')).toBeUndefined();
  expect(wrapper.vm.TEST_ONLY.gpuBudgetMiB.value).toBe('');
  expect(wrapper.vm.TEST_ONLY.weightResidency.value).toBe('auto');
  expect(wrapper.get('[data-testid="image-model-catalog"]').element.closest('fieldset')).toBeNull();
  expect(mocks.create).not.toHaveBeenCalled();
});
it('forwards an explicit budget and unsets it when the number input is cleared', async () => {
  mocks.generate.mockResolvedValue({ png: new Blob(['mock PNG'], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'mocked model' });
  wrapper = mount(ImageGenerationLab); await flushPromises();
  wrapper.vm.TEST_ONLY.files.value = { model: ggufFile() };
  wrapper.vm.TEST_ONLY.parameters.value.prompt = 'a small tree';
  const memory = wrapper.get('[data-testid="image-memory-budget"]');
  await memory.setValue('3072');
  await wrapper.vm.TEST_ONLY.generate();
  expect(mocks.generate.mock.calls[0]?.[0]?.request.gpuBudgetMiB).toBe(3072);
  await memory.setValue('');
  await wrapper.vm.TEST_ONLY.generate();
  expect(mocks.generate.mock.calls[1]?.[0]?.request.gpuBudgetMiB).toBeUndefined();
});
it('keeps copy/save diagnostics usable while a native request is indefinitely pending', async () => {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  let finish: ((value: { png: Blob, width: number, height: number, modelVersion: string }) => void) | undefined;
  mocks.generate.mockImplementation(({ request, onDiagnostic }) => {
    expect(request.debug).toBe('on');
    onDiagnostic({ diagnostic: { event: 'start', stage: 'model-load', elapsedMs: 120, fields: { gpuBudgetMiB: 'unset' } } });
    return new Promise(resolve => {
      finish = resolve;
    });
  });
  try {
    wrapper = mount(ImageGenerationLab); await flushPromises();
    await wrapper.get('[data-testid="image-debug-mode"]').setValue(true);
    wrapper.vm.TEST_ONLY.files.value = { model: ggufFile() }; wrapper.vm.TEST_ONLY.parameters.value.prompt = 'private prompt';
    const running = wrapper.vm.TEST_ONLY.generate(); await flushPromises();
    expect(wrapper.get('[data-testid="image-generate"]').element.matches(':disabled')).toBe(true);
    const copy = wrapper.get('[data-testid="image-copy-diagnostics"]');
    expect(copy.element.closest('fieldset')).toBeNull(); expect(copy.element.matches(':disabled')).toBe(false);
    expect(wrapper.get('[data-testid="image-save-diagnostics"]').element.matches(':disabled')).toBe(false);
    await copy.trigger('click'); await flushPromises();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('model-load'));
    expect(writeText.mock.calls[0]?.[0]).not.toContain('private prompt');
    finish!({ png: new Blob(['mock PNG'], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'mocked model' });
    await running;
  } finally {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard); else Reflect.deleteProperty(navigator, 'clipboard');
  }
});

it('shows image decoding separately from sampling without changing requested steps', async () => {
  let notify: ((args: { event: { phase: 'decoding', step: number, steps: number } }) => void) | undefined;
  let finish: ((result: { png: Blob, width: number, height: number, modelVersion: string }) => void) | undefined;
  mocks.generate.mockImplementation(({ onProgress }) => {
    notify = onProgress;
    return new Promise(resolve => {
      finish = resolve;
    });
  });
  wrapper = mount(ImageGenerationLab); await flushPromises();
  wrapper.vm.TEST_ONLY.files.value = { model: ggufFile() };
  wrapper.vm.TEST_ONLY.parameters.value.prompt = 'a small tree';
  wrapper.vm.TEST_ONLY.parameters.value.steps = 8;
  const running = wrapper.vm.TEST_ONLY.generate(); await flushPromises();
  notify!({ event: { phase: 'decoding', step: 0, steps: 1 } }); await flushPromises();
  expect(wrapper.text()).toContain('Decoding image…');
  expect(wrapper.vm.TEST_ONLY.parameters.value.steps).toBe(8);
  expect(wrapper.get('[data-testid="image-generate"]').element.matches(':disabled')).toBe(true);
  finish!({ png: new Blob(['mock PNG'], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'mocked model' });
  await running;
});

it('retains one client over six results, supports explicit release, and does not enforce the old four-image limit', async () => {
  mocks.generate.mockResolvedValue({ png: new Blob(['mock PNG'], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'mocked model' });
  wrapper = mount(ImageGenerationLab); await flushPromises();
  wrapper.vm.TEST_ONLY.files.value = { model: ggufFile() }; wrapper.vm.TEST_ONLY.parameters.value.prompt = 'first'; await flushPromises();
  for (let n = 0; n < 6; n++) {
    wrapper.vm.TEST_ONLY.parameters.value.prompt = `image ${n}`; await wrapper.vm.TEST_ONLY.generate();
  }
  await flushPromises();
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.dispose).not.toHaveBeenCalled();
  expect(wrapper.vm.TEST_ONLY.modelResident.value).toBe(true);
  expect(wrapper.findAll('[data-testid="image-generated-result"]')).toHaveLength(6);
  await wrapper.get('[data-testid="image-result-limit"]').setValue(3); await flushPromises();
  expect(wrapper.findAll('[data-testid="image-generated-result"]')).toHaveLength(3);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  await wrapper.get('[data-testid="image-release-model"]').trigger('click');
  expect(mocks.release).toHaveBeenCalled(); expect(wrapper.vm.TEST_ONLY.modelResident.value).toBe(false);
  expect(wrapper.vm.TEST_ONLY.results.value).toHaveLength(3);
  wrapper.unmount(); wrapper = undefined;
  expect(mocks.dispose).toHaveBeenCalledTimes(1); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(6);
});
it('keeps live preview ON/OFF and interval/size controls usable while sampling, and OFF still works with an empty interval', async () => {
  const finish = Promise.withResolvers<{ png: Blob, width: number, height: number, modelVersion: string }>();
  mocks.generate.mockReturnValueOnce(finish.promise);
  wrapper = mount(ImageGenerationLab); await flushPromises();
  wrapper.vm.TEST_ONLY.files.value = { model: ggufFile() }; wrapper.vm.TEST_ONLY.parameters.value.prompt = 'test'; await flushPromises();
  const task = wrapper.vm.TEST_ONLY.generate(); await flushPromises();
  const enabled = wrapper.get('[data-testid="image-preview-enabled"]');
  expect(enabled.element.closest('fieldset')).toBeNull(); expect(enabled.element.matches(':disabled')).toBe(false);
  expect(wrapper.get('[data-testid="image-preview-mode"]').element.matches(':disabled')).toBe(true);
  await enabled.setValue(true);
  await wrapper.get('[data-testid="image-preview-interval"]').setValue(1);
  await wrapper.get('[data-testid="image-preview-start-step"]').setValue(3);
  await wrapper.get('[data-testid="image-preview-size"]').setValue(128);
  expect(mocks.updatePreview).toHaveBeenLastCalledWith({ settings: { enabled: true, interval: 1, startStep: 3, maxEdge: 128, mode: 'vae' } });
  await wrapper.get('[data-testid="image-preview-interval"]').setValue('');
  await enabled.setValue(false);
  expect(mocks.updatePreview).toHaveBeenLastCalledWith({ settings: { enabled: false, interval: 1, startStep: 3, maxEdge: 128, mode: 'vae' } });
  finish.resolve({ png: new Blob(['png'], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'fixture' }); await task;
});
it('keeps snapshot URLs valid when the live image changes, bounds history, and revokes every owner on unmount', async () => {
  const finish = Promise.withResolvers<{ png: Blob, width: number, height: number, modelVersion: string }>();
  mocks.generate.mockReturnValueOnce(finish.promise);
  wrapper = mount(ImageGenerationLab); await flushPromises();
  wrapper.vm.TEST_ONLY.files.value = { model: ggufFile() }; wrapper.vm.TEST_ONLY.parameters.value.prompt = 'test';
  await wrapper.get('[data-testid="image-preview-enabled"]').setValue(true);
  expect(wrapper.get<HTMLInputElement>('[data-testid="image-keep-previews"]').element.checked).toBe(true);
  wrapper.vm.TEST_ONLY.maxPreviews.value = 2; await flushPromises();
  const task = wrapper.vm.TEST_ONLY.generate(); await flushPromises();
  const onPreview = mocks.generate.mock.calls[0]![0].onPreview;
  for (let step = 1; step <= 3; step++) {
    onPreview({ frame: { type: 'naidan-image-preview-v1', runId: 1, revision: 0, step, steps: 20, width: 32, height: 32, mode: 'projection', png: new Blob(['preview'], { type: 'image/png' }) } });
  }
  await flushPromises();
  const keep = wrapper.vm.TEST_ONLY.previewSnapshots.value;
  expect(keep.map(frame => frame.step)).toEqual([3, 2]);
  for (const frame of keep) expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(frame.url);
  expect(wrapper.findAll('[data-testid="image-preview-snapshot"]')).toHaveLength(2);
  finish.resolve({ png: new Blob(['png'], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'fixture' }); await task;
  wrapper.unmount(); wrapper = undefined;
  const created = vi.mocked(URL.createObjectURL).mock.results.map(result => result.value).sort();
  const revoked = vi.mocked(URL.revokeObjectURL).mock.calls.map(call => call[0]).sort();
  expect(revoked).toEqual(created);
});
it('leaves explicit generation parameters untouched and releases after success when retention is disabled', async () => {
  mocks.generate.mockResolvedValue({ png: new Blob(['png'], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'Qwen Image 2.1' });
  wrapper = mount(ImageGenerationLab); await flushPromises();
  wrapper.vm.TEST_ONLY.files.value = { model: ggufFile() };
  Object.assign(wrapper.vm.TEST_ONLY.parameters.value, { prompt: 'test', guidance: 3.25, seed: '99', qwenVaePolicy: 'native', vaeTileSize: 64 });
  await wrapper.get('[data-testid="image-retain-model"]').setValue(false); await flushPromises();
  await wrapper.vm.TEST_ONLY.generate(); await flushPromises();
  expect(mocks.generate.mock.calls[0]![0].request.parameters).toMatchObject({ guidance: 3.25, seed: '99', qwenVaePolicy: 'native', vaeTileSize: 64 });
  expect(mocks.release).toHaveBeenCalled(); expect(wrapper.vm.TEST_ONLY.modelResident.value).toBe(false);
  expect(wrapper.vm.TEST_ONLY.results.value).toHaveLength(1);
});

it('uses a fresh nanoid suffix for every diagnostic save during and after generation and releases temporary URLs', async () => {
  const finish = Promise.withResolvers<{ png: Blob, width: number, height: number, modelVersion: string }>();
  const downloadNames: string[] = [], urls: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloadNames.push(this.download); urls.push(this.href);
  });
  mocks.generate.mockImplementationOnce(({ onDiagnostic }) => {
    onDiagnostic({ diagnostic: { event: 'start', stage: 'sampling', elapsedMs: 0, fields: {} } });
    return finish.promise;
  });
  wrapper = mount(ImageGenerationLab); await flushPromises();
  wrapper.vm.TEST_ONLY.files.value = { model: ggufFile() };
  wrapper.vm.TEST_ONLY.parameters.value.prompt = 'a private description';
  const running = wrapper.vm.TEST_ONLY.generate(); await flushPromises();
  const save = wrapper.get('[data-testid="image-save-diagnostics"]');
  expect(save.element.matches(':disabled')).toBe(false);
  await save.trigger('click'); await save.trigger('click');
  finish.resolve({ png: new Blob(['png'], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'fixture' });
  await running; await save.trigger('click');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(downloadNames).toHaveLength(3);
  for (const name of downloadNames) expect(name).toMatch(/^naidan-image-diagnostics-[A-Za-z0-9_-]{21}\.jsonl$/);
  expect(new Set(downloadNames).size).toBe(3);
  for (const url of urls) expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
  expect(wrapper.vm.TEST_ONLY.parameters.value.prompt).toBe('a private description');
});

it('waits for cooperative stop before enabling generation and leaves the model resident', async () => {
  const gate = Promise.withResolvers<unknown>(); mocks.generate.mockReturnValueOnce(gate.promise);
  wrapper = mount(ImageGenerationLab); await flushPromises();
  wrapper.vm.TEST_ONLY.files.value = { model: ggufFile() }; wrapper.vm.TEST_ONLY.parameters.value.prompt = 'test'; await flushPromises();
  const task = wrapper.vm.TEST_ONLY.generate(); await flushPromises();
  const released = mocks.release.mock.calls.length;
  await wrapper.get('[data-testid="image-cancel"]').trigger('click');
  expect(mocks.cancel).toHaveBeenCalledOnce(); expect(wrapper.vm.TEST_ONLY.stopping.value).toBe(true);
  expect(wrapper.find('[data-testid="image-force-cancel"]').exists()).toBe(true);
  expect(mocks.release).toHaveBeenCalledTimes(released);
  gate.resolve({ cancelled: true, modelResident: true }); await task; await flushPromises();
  expect(wrapper.vm.TEST_ONLY.modelResident.value).toBe(true);
  expect(wrapper.vm.TEST_ONLY.results.value).toHaveLength(0);
  expect(wrapper.vm.TEST_ONLY.stopping.value).toBe(false);
  expect(wrapper.get('[data-testid="image-generate"]').element.matches(':disabled')).toBe(false);
});

it('inspects manual model contents and applies technical settings only on the explicit button', async () => {
  wrapper = mount(ImageGenerationLab); await flushPromises();
  mocks.inspect.mockResolvedValueOnce({ candidates: [{ family: 'qwen-image-2.1', variant: 'unknown', evidence: ['tensor dimensions'], roles: ['model'] }], issues: [] });
  const file = ggufFile(), input = wrapper.get<HTMLInputElement>('[data-testid="image-file-model"]');
  Object.defineProperty(input.element, 'files', { configurable: true, value: [file] });
  wrapper.vm.TEST_ONLY.parameters.value.prompt = 'keep prompt'; wrapper.vm.TEST_ONLY.parameters.value.seed = '123';
  wrapper.vm.TEST_ONLY.parameters.value.guidance = 2.5;
  await input.trigger('change'); await flushPromises();
  expect(wrapper.vm.TEST_ONLY.recommendation.value?.title).toBe('Qwen Image 2.1');
  expect(wrapper.vm.TEST_ONLY.parameters.value.guidance).toBe(2.5);
  expect(mocks.inspect.mock.lastCall?.[0].repositories[0].files[0].file).toBe(file);
  await wrapper.get('[data-testid="image-apply-recommendation"]').trigger('click');
  expect(wrapper.vm.TEST_ONLY.parameters.value).toMatchObject({ prompt: 'keep prompt', seed: '123', guidance: 6, sampler: 'euler', width: 512 });
  expect(wrapper.vm.TEST_ONLY.preview.value).toMatchObject({ enabled: false, startStep: 8 });
  expect(mocks.generate).not.toHaveBeenCalled();
});

it('places the single debug toggle next to generation controls and keeps it locked while generating', async () => {
  const finish = Promise.withResolvers<unknown>(); mocks.generate.mockReturnValue(finish.promise);
  wrapper = mount(ImageGenerationLab); await flushPromises();
  const toggles = wrapper.findAll('[data-testid="image-debug-mode"]'); expect(toggles).toHaveLength(1);
  expect(wrapper.get('[data-testid="image-generation-actions"]').find('[data-testid="image-debug-mode"]').exists()).toBe(true);
  expect(wrapper.get('[data-testid="image-live-diagnostics"]').find('[data-testid="image-debug-mode"]').exists()).toBe(false);
  wrapper.vm.TEST_ONLY.files.value = { model: ggufFile() }; wrapper.vm.TEST_ONLY.parameters.value.prompt = 'test'; await flushPromises();
  await toggles[0]!.setValue(true); const operation = wrapper.vm.TEST_ONLY.generate(); await flushPromises();
  expect(toggles[0]!.element.matches(':disabled')).toBe(true);
  expect(mocks.generate.mock.calls[0]?.[0].request.debug).toBe('on');
  finish.resolve({ png: new Blob(['png'], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'test' });
  await operation; await flushPromises(); expect(toggles[0]!.element.matches(':disabled')).toBe(false);
});

function benchmarkInventory(): ModelInventory {
  return { candidates: ['one','two'].map(name => {
    const file = ggufFile();
    return { id: `user/${name}`, repositoryId: `user/${name}`, path: 'model.gguf', files: [{ path: 'model.gguf', file }], size: file.size, format: 'gguf',
      family: 'sd-checkpoint', classes: [], roles: ['model'], evidence: ['synthetic test'], variant: 'unknown', turboHint: false, issue: undefined };
  }), issues: [] };
}
it('uses saved adapters explicitly in normal generation and independently in one diagnostics target', async () => {
  const inventory = benchmarkInventory(), file = new File(['adapter fixture'], 'style.safetensors');
  inventory.candidates.push({ id: 'saved-style', repositoryId: 'user/adapters', path: 'style.safetensors', files: [{ path: 'style.safetensors', file }],
    size: file.size, format: 'safetensors', family: 'unknown', classes: ['lora'], roles: [], evidence: [], issue: undefined, turboHint: false, variant: 'unknown' });
  mocks.inspect.mockResolvedValue(inventory);
  mocks.generate.mockImplementation(async ({ request }) => ({ png: new Blob(['PNG']), width: request.parameters.width, height: request.parameters.height, modelVersion: 'fixture' }));
  wrapper = mount(ImageGenerationLab); await flushPromises();
  const view = wrapper.vm.TEST_ONLY;
  expect(view.loras.value).toEqual([]);
  await wrapper.get('[data-testid="image-lora-saved"]').setValue('saved-style');
  await wrapper.get('[data-testid="image-lora-add-saved"]').trigger('click');
  view.parameters.value.prompt = 'saved adapter';
  await view.generate(); await flushPromises();
  const request = mocks.generate.mock.calls[0]![0].request;
  expect(request.loras).toEqual([{ file, path: 'style.safetensors', strength: 1 }]);
  expect(request.loras[0].file).toBe(file);
  await wrapper.get('[data-testid="image-tab-measure"]').trigger('click');
  const rows = wrapper.findAll('[data-testid="benchmark-target"]');
  expect(rows).toHaveLength(2);
  expect(rows.every(row => row.findAll('[data-testid="image-lora-row"]').length === 0)).toBe(true);
  await rows[0]!.get('[data-testid="image-lora-saved"]').setValue('saved-style');
  await rows[0]!.get('[data-testid="image-lora-add-saved"]').trigger('click');
  await rows[0]!.get('[data-testid="image-lora-strength"]').setValue('0.25');
  const bench = view.benchmark; bench.protocol.value.repeats = 1; bench.protocol.value.cooldownSeconds = 0;
  await bench.start(); await flushPromises();
  expect(mocks.generate.mock.calls.slice(1).map(([{ request }]) => request.loras.map((item: { strength: number }) => item.strength))).toEqual([[0.25], []]);
  expect(view.loras.value[0]?.strength).toBe(1); expect(request.loras[0].strength).toBe(1);
});
it('opens benchmark lazily, selects every complete local model and preserves deselection across refresh', async () => {
  mocks.inspect.mockResolvedValue(benchmarkInventory()); wrapper = mount(ImageGenerationLab); await flushPromises();
  expect(wrapper.find('[data-testid="image-benchmark"]').exists()).toBe(false);
  await wrapper.get('[data-testid="image-tab-measure"]').trigger('click'); await flushPromises();
  expect(wrapper.findAll('[data-testid="benchmark-target"]')).toHaveLength(2);
  expect(wrapper.vm.TEST_ONLY.benchmark.selected.value).toEqual(['user/one','user/two']);
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="benchmark-select-none"]').trigger('click');
  window.dispatchEvent(new Event('focus')); await flushPromises();
  expect(wrapper.vm.TEST_ONLY.benchmark.selected.value).toEqual([]);
  await wrapper.get('[data-testid="benchmark-select-all"]').trigger('click');
  expect(wrapper.vm.TEST_ONLY.benchmark.selected.value).toHaveLength(2);
});
it('defaults to two fresh runs with retained PNGs and clears opened result images with a new measurement', async () => {
  mocks.inspect.mockResolvedValue(benchmarkInventory());
  mocks.generate.mockImplementation(async ({ request }) => ({ png: new Blob(['PNG'], { type: 'image/png' }), width: request.parameters.width, height: request.parameters.height, modelVersion: 'fixture' }));
  wrapper = mount(ImageGenerationLab); await flushPromises();
  await wrapper.get('[data-testid="image-tab-measure"]').trigger('click');
  const bench = wrapper.vm.TEST_ONLY.benchmark;
  expect(bench.protocol.value).toMatchObject({ mode: 'fresh-each', repeats: 2, keepImages: true });
  expect(bench.common.value).toMatchObject({ width: 512, height: 512 });
  bench.protocol.value.cooldownSeconds = 0;
  await bench.start(); await flushPromises();
  expect(mocks.create).toHaveBeenCalledTimes(4); expect(mocks.dispose).toHaveBeenCalledTimes(4);
  expect(bench.runs.value.every(run => run.png && run.record.plannedKind === 'cold')).toBe(true);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  const details = wrapper.findAll<HTMLDetailsElement>('[data-testid="benchmark-result-details"]')[0]!;
  details.element.open = true; await details.trigger('toggle');
  expect(wrapper.get('[data-testid="benchmark-result-image"]').attributes('src')).toBe('blob:test-image-1');
  await wrapper.get('[data-testid="benchmark-clear"]').trigger('click');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-image-1');
  expect(wrapper.find('[data-testid="benchmark-result-image"]').exists()).toBe(false);
});
function componentInventory(): ModelInventory {
  const candidates: ModelInventory['candidates'] = ['one', 'two'].map(name => ({
    id: `user/${name}`, repositoryId: `user/${name}`, path: 'diffusion.gguf', files: [{ path: 'diffusion.gguf', file: ggufFile() }], size: 512,
    format: 'gguf', family: 'z-image', classes: [], roles: ['diffusion'], evidence: [], variant: 'turbo', turboHint: true, issue: undefined,
  }));
  for (const name of ['vae-a', 'vae-b', 'text']) {
    const slot = name === 'text' ? 'lm' : 'vae';
    candidates.push({ id: `user/${name}`, repositoryId: `user/${name}`, path: 'shared.gguf', files: [{ path: 'shared.gguf', file: ggufFile() }], size: 512,
      format: 'gguf', family: 'unknown', classes: [slot === 'lm' ? 'lm-qwen3-4b' : 'vae-flux16'], roles: [slot], evidence: [], variant: 'unknown', turboHint: false, issue: undefined });
  }
  return { candidates, issues: [] };
}
it('keeps diagnostics LoRA selections independent per model and records the frozen requested settings', async () => {
  mocks.inspect.mockResolvedValue(benchmarkInventory());
  mocks.generate.mockImplementation(async ({ request }) => ({ png: new Blob(['PNG']), width: request.parameters.width, height: request.parameters.height, modelVersion: 'fixture' }));
  wrapper = mount(ImageGenerationLab); await flushPromises();
  const file = new File(['adapter fixture'], 'style.safetensors');
  wrapper.vm.TEST_ONLY.loras.value = [{ file, strength: 1.5, enabled: true }];
  await wrapper.get('[data-testid="image-tab-measure"]').trigger('click');
  const bench = wrapper.vm.TEST_ONLY.benchmark;
  expect(bench.loras.value).toEqual({});
  const rows = wrapper.findAll('[data-testid="benchmark-target"]');
  const input = rows[0]!.get<HTMLInputElement>('[data-testid="image-lora-files"]');
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
  await input.trigger('change');
  await rows[0]!.get('[data-testid="image-lora-strength"]').setValue('0.5');
  expect(rows[1]!.findAll('[data-testid="image-lora-row"]')).toHaveLength(0);
  expect(wrapper.vm.TEST_ONLY.loras.value[0]?.strength).toBe(1.5);
  bench.protocol.value.cooldownSeconds = 0; bench.protocol.value.repeats = 1;
  await bench.start(); await flushPromises();
  expect(mocks.generate.mock.calls.map(([{ request }]) => request.loras.map((lora: { strength: number }) => lora.strength))).toEqual([[0.5], []]);
  bench.loras.value = {};
  const manifest = benchmarkManifest({ snapshot: { plan: bench.plan.value!, runs: bench.runs.value, state: 'finished' }, includePrompts: false, includeInputImages: 'omit', exportedAt: 'now' });
  expect(manifest.models[0]!.request.loras).toEqual([{ file: { path: file.name, bytes: file.size, lastModified: file.lastModified }, strength: 0.5 }]);
  expect(manifest.models[1]!.request).not.toHaveProperty('loras');
});
it('shows editable companion selections per target and snapshots their exact identities into requests and exports', async () => {
  mocks.inspect.mockResolvedValue(componentInventory());
  mocks.generate.mockImplementation(async ({ request }) => ({ png: new Blob(['PNG'], { type: 'image/png' }), width: request.parameters.width, height: request.parameters.height, modelVersion: 'fixture' }));
  wrapper = mount(ImageGenerationLab); await flushPromises();
  const library = wrapper.getComponent(ImageModelLibrary).props('view');
  const normal = library.selectedModels();
  await wrapper.get('[data-testid="image-tab-measure"]').trigger('click');
  const bench = wrapper.vm.TEST_ONLY.benchmark;
  const rows = wrapper.findAll('[data-testid="benchmark-target"]');
  expect(rows[0]!.get('[data-testid="benchmark-component-vae"] select').element).toHaveProperty('value', 'user/vae-a');
  expect(rows[0]!.get('[data-testid="benchmark-component-lm"] select').element).toHaveProperty('value', 'user/text');
  await rows[0]!.get('[data-testid="benchmark-component-vae"] select').setValue('user/vae-b');
  expect(rows[1]!.get('[data-testid="benchmark-component-vae"] select').element).toHaveProperty('value', 'user/vae-a');
  expect(library.selectedModels()).toEqual(normal);
  await rows[0]!.get('[data-testid="benchmark-component-lm"] select').setValue('');
  expect(bench.selected.value).toContain('user/one'); expect(bench.canStart.value).toBe(false);
  await bench.start(); expect(mocks.create).not.toHaveBeenCalled();
  await rows[0]!.get('[data-testid="benchmark-component-lm"] select').setValue('user/text');
  expect(bench.canStart.value).toBe(true);
  bench.protocol.value.cooldownSeconds = 0; bench.protocol.value.repeats = 1;
  const expected = bench.targets.value[0]!.models!.find(model => model.slot === 'vae')!.file;
  await bench.start(); await flushPromises();
  expect(mocks.generate.mock.calls[0]![0].request.models.find((model: { slot: string }) => model.slot === 'vae').file).toBe(expected);
  const plan = bench.plan.value!;
  bench.componentSelections.value = { 'user/one': { vae: 'user/vae-a' } };
  const manifest = benchmarkManifest({ snapshot: { plan, runs: bench.runs.value, state: 'finished' }, includePrompts: false, includeInputImages: 'omit', exportedAt: 'now' });
  expect(manifest.models[0]!.request.models.find(model => model.slot === 'vae')!.localCandidateId).toBe('user/vae-b');
  expect(manifest.models[1]!.request.models.find(model => model.slot === 'vae')!.localCandidateId).toBe('user/vae-a');
});
it('locks normal generation during a frozen multi-model run, reuses per model, and retains results across tabs', async () => {
  mocks.inspect.mockResolvedValue(benchmarkInventory());
  const first = Promise.withResolvers<unknown>(); let calls = 0;
  mocks.generate.mockImplementation(async ({ request, onDiagnostic }) => {
    const number = calls++;
    onDiagnostic({ diagnostic: { event: 'native', stage: 'sampling', elapsedMs: 100, fields: { metric: 'run-wall', perfVersion: 1, sampling: 80, 'model-load': 20 } } });
    if (!number) await first.promise;
    return { png: new Blob(['png'], { type: 'image/png' }), width: request.parameters.width, height: request.parameters.height, modelVersion: 'synthetic test', uniformOutput: false };
  });
  wrapper = mount(ImageGenerationLab); await flushPromises();
  const b = wrapper.vm.TEST_ONLY.benchmark; b.protocol.value = { ...b.protocol.value, cooldownSeconds: 0, mode: 'cold-warm', repeats: 3 };
  await wrapper.get('[data-testid="image-tab-measure"]').trigger('click');
  const task = b.start(); await flushPromises();
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(wrapper.get('[data-testid="benchmark-start"]').element.matches(':disabled')).toBe(true);
  expect(wrapper.get('[data-testid="benchmark-repeats"]').element.matches(':disabled')).toBe(true);
  const captured = b.plan.value!; const originalSteps = captured.models[1]!.request.parameters.steps;
  // Even a programmatic form edit cannot alter requests already in the batch.
  b.common.value.steps = 91;
  await wrapper.get('[data-testid="image-tab-generate"]').trigger('click');
  await wrapper.vm.TEST_ONLY.generate(); expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(wrapper.get('[data-testid="image-generate"]').element.matches(':disabled')).toBe(true);
  first.resolve(undefined); await task; await flushPromises();
  expect(mocks.generate).toHaveBeenCalledTimes(6); expect(mocks.create).toHaveBeenCalledTimes(2); expect(mocks.dispose).toHaveBeenCalledTimes(2);
  expect(mocks.generate.mock.calls.every(([args]) => args.request.parameters.steps === originalSteps)).toBe(true);
  expect(b.runs.value).toHaveLength(6); expect(wrapper.vm.TEST_ONLY.results.value).toEqual([]);
  await wrapper.get('[data-testid="image-tab-measure"]').trigger('click'); await flushPromises();
  expect(wrapper.findAll('[data-testid="benchmark-run"]')).toHaveLength(6);
  expect(wrapper.get('[data-testid="benchmark-download"]').element.matches(':disabled')).toBe(false);
  expect(wrapper.get('[data-testid="benchmark-start"]').element.matches(':disabled')).toBe(true);
});
it('materializes only the edited per-model field and keeps all other shared changes inherited', async () => {
  mocks.inspect.mockResolvedValue(benchmarkInventory()); wrapper = mount(ImageGenerationLab); await flushPromises();
  await wrapper.get('[data-testid="image-tab-measure"]').trigger('click');
  const b = wrapper.vm.TEST_ONLY.benchmark, target = b.targets.value[0]!;
  const row = wrapper.findAll('[data-testid="benchmark-target"]')[0]!;
  await row.get('[data-testid="override-steps"]').setValue(true);
  await row.get('[data-testid="parameter-steps"]').setValue(5);
  expect(Object.keys(b.overrides.value[target.id]!)).toEqual(['steps']);
  b.common.value.width = 640; b.common.value.steps = 10;
  expect(b.effective({ target })).toMatchObject({ width: 640, steps: 5 });
  await row.get('[data-testid="override-steps"]').setValue(false);
  expect(b.effective({ target }).steps).toBe(10);
});
it('uses shared or per-model BF16 conversion in diagnostics without changing the normal form', async () => {
  mocks.inspect.mockResolvedValue(benchmarkInventory()); wrapper = mount(ImageGenerationLab); await flushPromises();
  await wrapper.get('[data-testid="image-tab-measure"]').trigger('click');
  const bench = wrapper.vm.TEST_ONLY.benchmark;
  const common = wrapper.findAll('[data-testid="benchmark-parameters"]')[0]!;
  await common.get('[data-testid="parameter-bf16WeightType"]').setValue('f16');
  const target = bench.targets.value[0]!;
  const row = wrapper.findAll('[data-testid="benchmark-target"]')[0]!;
  expect(row.get('[data-testid="parameter-bf16WeightType"]').element).toHaveProperty('value', 'f16');
  expect(row.get('[data-testid="parameter-bf16WeightType"]').element.matches(':disabled')).toBe(true);
  await row.get('[data-testid="override-bf16WeightType"]').setValue(true);
  await row.get('[data-testid="parameter-bf16WeightType"]').setValue('f32');
  expect(bench.overrides.value[target.id]).toEqual({ bf16WeightType: 'f32' });
  expect(bench.effective({ target }).bf16WeightType).toBe('f32');
  await row.get('[data-testid="override-bf16WeightType"]').setValue(false);
  expect(bench.effective({ target }).bf16WeightType).toBe('f16');
  expect(wrapper.vm.TEST_ONLY.parameters.value.bf16WeightType).toBe('f32');
  expect(bench.common.value.prompt).toContain('A fluffy cat curled up asleep');
});
it('applies compact resolution presets to common settings or both per-model dimensions while retaining manual input', async () => {
  mocks.inspect.mockResolvedValue(benchmarkInventory()); wrapper = mount(ImageGenerationLab); await flushPromises();
  const normalSize = { width: wrapper.vm.TEST_ONLY.parameters.value.width, height: wrapper.vm.TEST_ONLY.parameters.value.height };
  await wrapper.get('[data-testid="image-tab-measure"]').trigger('click');
  const bench = wrapper.vm.TEST_ONLY.benchmark;
  const common = wrapper.findAll('[data-testid="benchmark-parameters"]')[0]!;
  const target = wrapper.findAll('[data-testid="benchmark-target"]')[0]!;
  expect(common.get('[data-testid="benchmark-resolution-512"]').attributes('aria-pressed')).toBe('true');
  await common.get('[data-testid="benchmark-resolution-256"]').trigger('click');
  expect(bench.common.value).toMatchObject({ width: 256, height: 256 });
  await target.get('[data-testid="benchmark-resolution-768"]').trigger('click');
  expect(bench.overrides.value['user/one']).toEqual({ width: 768, height: 768 });
  expect(bench.overrides.value['user/two']).toBeUndefined();
  await target.get('[data-testid="parameter-width"]').setValue(640);
  expect(target.findAll('[data-testid="benchmark-resolution-presets"] button[aria-pressed="true"]')).toHaveLength(0);
  expect(bench.effective({ target: bench.targets.value[0]! })).toMatchObject({ width: 640, height: 768 });
  await common.get('[data-testid="benchmark-resolution-1024"]').trigger('click');
  await target.get('[data-testid="override-width"]').setValue(false);
  await target.get('[data-testid="override-height"]').setValue(false);
  expect(bench.effective({ target: bench.targets.value[0]! })).toMatchObject({ width: 1024, height: 1024 });
  expect(target.get('[data-testid="benchmark-resolution-1024"]').attributes('aria-pressed')).toBe('true');
  expect(wrapper.vm.TEST_ONLY.parameters.value).toMatchObject(normalSize);
});
it('releases the benchmark worker on unmount and does not launch the remaining queue', async () => {
  mocks.inspect.mockResolvedValue(benchmarkInventory()); mocks.generate.mockReturnValue(new Promise(() => undefined));
  wrapper = mount(ImageGenerationLab); await flushPromises();
  const b = wrapper.vm.TEST_ONLY.benchmark; b.protocol.value.cooldownSeconds = 0;
  const task = b.start(); await flushPromises();
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  wrapper.unmount(); wrapper = undefined; await task;
  expect(mocks.generate).toHaveBeenCalledTimes(1); expect(mocks.dispose).toHaveBeenCalledTimes(1);
});
it('supports keyboard tabs and never hides a running benchmark by destroying its owner', async () => {
  wrapper = mount(ImageGenerationLab); await flushPromises();
  await wrapper.get('[data-testid="image-tab-generate"]').trigger('keydown', { key: 'End' });
  expect(wrapper.get('[data-testid="image-tab-measure"]').attributes('aria-selected')).toBe('true');
  expect(wrapper.get('[data-testid="image-tab-generate"]').attributes('tabindex')).toBe('-1');
  await wrapper.get('[data-testid="image-tab-measure"]').trigger('keydown', { key: 'Home' });
  expect(wrapper.get('[data-testid="image-tab-generate"]').attributes('aria-selected')).toBe('true');
  expect(mocks.create).not.toHaveBeenCalled();
});
it('does not start a benchmark while ordinary generation is active or change its settings', async () => {
  const hold = Promise.withResolvers<unknown>(); mocks.generate.mockReturnValueOnce(hold.promise);
  mocks.inspect.mockResolvedValue(benchmarkInventory()); wrapper = mount(ImageGenerationLab); await flushPromises();
  const normal = wrapper.vm.TEST_ONLY; normal.files.value = { model: ggufFile() }; normal.parameters.value.prompt = 'normal prompt';
  const task = normal.generate(); await flushPromises(); await wrapper.get('[data-testid="image-tab-measure"]').trigger('click');
  expect(wrapper.get('[data-testid="benchmark-start"]').element.matches(':disabled')).toBe(true);
  await normal.benchmark.start(); expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(normal.parameters.value.prompt).toBe('normal prompt');
  hold.resolve({ cancelled: true, modelResident: true }); await task;
});
it('releases the normally retained model before the first benchmark client, then leaves the normal gallery intact', async () => {
  mocks.inspect.mockResolvedValue(benchmarkInventory());
  mocks.generate.mockImplementation(async ({ request }) => ({ png: new Blob(['png'], { type: 'image/png' }), width: request.parameters.width, height: request.parameters.height, modelVersion: 'fixture' }));
  wrapper = mount(ImageGenerationLab); await flushPromises();
  wrapper.vm.TEST_ONLY.parameters.value.prompt = 'ordinary'; await wrapper.vm.TEST_ONLY.generate();
  expect(wrapper.vm.TEST_ONLY.modelResident.value).toBe(true);
  const benchmark = wrapper.vm.TEST_ONLY.benchmark; benchmark.protocol.value.cooldownSeconds = 0; benchmark.protocol.value.repeats = 1;
  const countBefore = mocks.release.mock.calls.length;
  await benchmark.start();
  expect(mocks.release.mock.calls.length).toBe(countBefore + 1);
  const releaseOrder = mocks.release.mock.invocationCallOrder.at(-1)!;
  expect(releaseOrder).toBeLessThan(mocks.create.mock.invocationCallOrder[1]!);
  expect(wrapper.vm.TEST_ONLY.results.value).toHaveLength(1);
  expect(wrapper.vm.TEST_ONLY.modelResident.value).toBe(false);
});
it('loads the Japanese benchmark interface using the registered message catalog', async () => {
  await ensureAllStringsForTest({ locale: 'ja' }); mocks.inspect.mockResolvedValue(benchmarkInventory());
  wrapper = mount(ImageGenerationLab); await flushPromises(); await wrapper.get('[data-testid="image-tab-measure"]').trigger('click');
  expect(wrapper.get('[data-testid="benchmark-start"]').text()).toContain('計測');
  expect(wrapper.get('[data-testid="benchmark-download"]').text()).toContain('ZIP');
  expect(wrapper.get('[data-testid="image-benchmark"]').text()).not.toContain('undefined');
});

it('snapshots image conditioning, accepts changed images on the next run and clears on base model changes', async () => {
  const pending = Promise.withResolvers<{ png: Blob, width: number, height: number, modelVersion: string }>();
  mocks.generate.mockReturnValueOnce(pending.promise);
  mocks.generate.mockResolvedValue({ png: new Blob(['PNG']), width: 256, height: 256, modelVersion: 'fixture' });
  wrapper = mount(ImageGenerationLab); await flushPromises();
  const view = wrapper.vm.TEST_ONLY;
  view.files.value = { model: ggufFile() }; view.parameters.value.prompt = 'change the background';
  const first = new File(['one'], 'same.png', { type: 'image/png' }), second = new File(['two'], 'same.png', { type: 'image/png' });
  view.imageInputs.value = { initImage: first, strength: 0.4, referenceImages: [first] };
  const task = view.generate(); await flushPromises();
  expect(wrapper.get('[data-testid="image-input-initial"]').element.matches(':disabled')).toBe(true);
  view.imageInputs.value = { initImage: undefined, strength: 0.9, referenceImages: [second] };
  expect(mocks.generate.mock.calls[0]![0].request.imageInputs).toEqual({ initImage: first, strength: 0.4, referenceImages: [first] });
  pending.resolve({ png: new Blob(['PNG']), width: 256, height: 256, modelVersion: 'fixture' }); await task; await flushPromises();
  await view.generate();
  expect(mocks.generate.mock.calls[1]![0].request.imageInputs.referenceImages[0]).toBe(second);
  view.files.value = { model: ggufFile() };
  expect(view.imageInputs.value).toEqual({ initImage: undefined, strength: 0.75, referenceImages: [] });
  await view.generate(); expect(mocks.generate.mock.calls[2]![0].request.imageInputs.referenceImages).toEqual([]);
});

it('keeps conditioning per target and lets completed measurements change image export inclusion without rerunning', async () => {
  mocks.inspect.mockResolvedValue(benchmarkInventory());
  mocks.generate.mockImplementation(async ({ request }) => ({ png: new Blob(['PNG']), width: request.parameters.width, height: request.parameters.height, modelVersion: 'fixture' }));
  wrapper = mount(ImageGenerationLab); await flushPromises();
  const file = new File(['reference'], 'image.png', { type: 'image/png' });
  wrapper.vm.TEST_ONLY.imageInputs.value = { initImage: file, strength: 0.4, referenceImages: [] };
  await wrapper.get('[data-testid="image-tab-measure"]').trigger('click');
  const bench = wrapper.vm.TEST_ONLY.benchmark;
  const row = wrapper.findAll('[data-testid="benchmark-target"]')[0]!;
  const input = row.get<HTMLInputElement>('[data-testid="image-input-references"]');
  Object.defineProperty(input.element, 'files', { configurable: true, value: [file] }); await input.trigger('change');
  bench.protocol.value.cooldownSeconds = 0; bench.protocol.value.repeats = 1;
  await bench.start(); await flushPromises();
  expect(mocks.generate.mock.calls.map(([{ request }]) => request.imageInputs.referenceImages.length)).toEqual([1, 0]);
  expect(wrapper.vm.TEST_ONLY.imageInputs.value.initImage).toBe(file);
  const option = wrapper.get('[data-testid="benchmark-input-images"]');
  expect(option.element.matches(':disabled')).toBe(false); expect(bench.includeInputImages.value).toBe('omit');
  await option.setValue(true); expect(bench.includeInputImages.value).toBe('include');
  await option.setValue(false); expect(bench.includeInputImages.value).toBe('omit');
  expect(mocks.generate).toHaveBeenCalledTimes(2); expect(bench.plan.value!.models[0]!.request.imageInputs.referenceImages[0]).toBe(file);
});
