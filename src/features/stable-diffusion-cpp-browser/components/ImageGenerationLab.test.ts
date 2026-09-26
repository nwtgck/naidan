import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageGenerationLab from './ImageGenerationLab.vue';
import { ggufFile } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
vi.mock('../capabilities', () => ({ initialProfile: () => 'webgpu-wasm32-asyncify', supportsJspi: () => false, supportsMemory64: () => false }));
const mocks = vi.hoisted(() => ({ create: vi.fn(), generate: vi.fn(), dispose: vi.fn(), release: vi.fn(), updatePreview: vi.fn() }));
vi.mock('@/features/stable-diffusion-cpp-browser/worker/client', () => ({ createImageClient: () => {
  mocks.create(); return { generate: mocks.generate, dispose: mocks.dispose, release: mocks.release, updatePreview: mocks.updatePreview };
} }));
vi.mock('virtual:stable-diffusion-cpp-browser/config', () => ({ default: {
  kind: 'available', sourceCommit: 'a'.repeat(40), artifacts: [{ profile: 'webgpu-wasm32-asyncify', modulePath: `stable-diffusion-cpp-runtime/${'a'.repeat(40)}/webgpu-wasm32-asyncify/core.mjs`, wasmPath: `stable-diffusion-cpp-runtime/${'a'.repeat(40)}/webgpu-wasm32-asyncify/core.wasm.gz`, helpersPath: `stable-diffusion-cpp-runtime/${'a'.repeat(40)}/examples/runtime/index.mjs`, schemaSha256: '1'.repeat(64), wasmBytes: 8, wasmSha256: '0'.repeat(64) }],
} }));
let wrapper: VueWrapper<InstanceType<typeof ImageGenerationLab>> | undefined;
const descriptor = Object.getOwnPropertyDescriptor(navigator, 'gpu');
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.resetAllMocks(); vi.stubGlobal('isSecureContext', true); vi.stubGlobal('OffscreenCanvas', class {}); vi.stubGlobal('DecompressionStream', class {});
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
  await wrapper.get('[data-testid="image-preview-size"]').setValue(128);
  expect(mocks.updatePreview).toHaveBeenLastCalledWith({ settings: { enabled: true, interval: 1, maxEdge: 128, mode: 'projection' } });
  await wrapper.get('[data-testid="image-preview-interval"]').setValue('');
  await enabled.setValue(false);
  expect(mocks.updatePreview).toHaveBeenLastCalledWith({ settings: { enabled: false, interval: 1, maxEdge: 128, mode: 'projection' } });
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
