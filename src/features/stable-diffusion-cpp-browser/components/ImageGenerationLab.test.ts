import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageGenerationLab from './ImageGenerationLab.vue';
import { ggufFile } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
vi.mock('../capabilities', () => ({ initialProfile: () => 'webgpu-wasm32-asyncify', supportsJspi: () => false, supportsMemory64: () => false }));
const mocks = vi.hoisted(() => ({ create: vi.fn(), generate: vi.fn(), dispose: vi.fn() }));
vi.mock('@/features/stable-diffusion-cpp-browser/worker/client', () => ({ createImageClient: () => {
  mocks.create(); return { generate: mocks.generate, dispose: mocks.dispose };
} }));
vi.mock('virtual:stable-diffusion-cpp-browser/config', () => ({ default: {
  kind: 'available', sourceCommit: 'a'.repeat(40), artifacts: [{ profile: 'webgpu-wasm32-asyncify', modulePath: `stable-diffusion-cpp-runtime/${'a'.repeat(40)}/webgpu-wasm32-asyncify/core.mjs`, wasmPath: `stable-diffusion-cpp-runtime/${'a'.repeat(40)}/webgpu-wasm32-asyncify/core.wasm.gz`, helpersPath: `stable-diffusion-cpp-runtime/${'a'.repeat(40)}/examples/runtime/index.mjs`, schemaSha256: '1'.repeat(64), wasmBytes: 8, wasmSha256: '0'.repeat(64) }],
} }));
let wrapper: VueWrapper<InstanceType<typeof ImageGenerationLab>> | undefined;
const descriptor = Object.getOwnPropertyDescriptor(navigator, 'gpu');
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.clearAllMocks(); vi.stubGlobal('isSecureContext', true); vi.stubGlobal('OffscreenCanvas', class {}); vi.stubGlobal('DecompressionStream', class {});
  Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true });
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = vi.fn(() => 'blob:test-image'); static override revokeObjectURL = vi.fn();
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
  expect(wrapper.get('a[download]').attributes('download')).toBe('naidan-image-42.png');
  wrapper.unmount(); wrapper = undefined; expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-image');
});

it('keeps the working-memory budget in collapsed advanced settings and the catalog outside the model fieldset', async () => {
  wrapper = mount(ImageGenerationLab); await flushPromises();
  const memory = wrapper.get('[data-testid="image-memory-budget"]');
  expect(memory.element.closest('details')?.hasAttribute('open')).toBe(false);
  expect(memory.element.closest('details')?.textContent).toContain('not to limit model file size');
  expect(wrapper.vm.TEST_ONLY.gpuBudgetMiB.value).toBe(2048);
  expect(wrapper.get('[data-testid="image-model-catalog"]').element.closest('fieldset')).toBeNull();
  expect(mocks.create).not.toHaveBeenCalled();
});
it('keeps copy/save diagnostics usable while a native request is indefinitely pending', async () => {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  let finish: ((value: { png: Blob, width: number, height: number, modelVersion: string }) => void) | undefined;
  mocks.generate.mockImplementation(({ request, onDiagnostic }) => {
    expect(request.debug).toBe('on');
    onDiagnostic({ diagnostic: { event: 'start', stage: 'model-load', elapsedMs: 120, fields: { gpuBudgetMiB: 2048 } } });
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
