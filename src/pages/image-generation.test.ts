import { defineComponent, h } from 'vue';
import ImageGenerationSidebar from '@/features/stable-diffusion-cpp-browser/components/ImageGenerationSidebar.vue';
import { useImageGenerationWorkspaceNavigation } from '@/features/stable-diffusion-cpp-browser/session/navigation';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router';
import { routes } from 'vue-router/auto-routes';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageGenerationLab from '@/features/stable-diffusion-cpp-browser/components/ImageGenerationLab.vue';
import { ggufFile } from '@/features/stable-diffusion-cpp-browser/test-fixtures';

const mocks = vi.hoisted(() => ({ create: vi.fn(), generate: vi.fn(), dispose: vi.fn(), release: vi.fn(), inspect: vi.fn() }));
vi.mock('@/features/stable-diffusion-cpp-browser/inventory-worker/client', () => ({ inspectImageInventory: (...args: unknown[]) => mocks.inspect(...args) }));
vi.mock('@/features/stable-diffusion-cpp-browser/capabilities', () => ({ initialProfile: () => 'webgpu-wasm32-asyncify', supportsJspi: () => false, supportsMemory64: () => false }));
vi.mock('@/features/stable-diffusion-cpp-browser/worker/client', () => ({ createImageClient: () => {
  mocks.create(); return { generate: mocks.generate, dispose: mocks.dispose, release: mocks.release, cancel() {}, updatePreview() {} };
} }));
vi.mock('virtual:stable-diffusion-cpp-browser/config', () => ({ default: {
  kind: 'available', sourceCommit: 'a'.repeat(40), artifacts: [{ profile: 'webgpu-wasm32-asyncify', modulePath: `stable-diffusion-cpp-runtime/${'a'.repeat(40)}/webgpu-wasm32-asyncify/core.mjs`, wasmPath: `stable-diffusion-cpp-runtime/${'a'.repeat(40)}/webgpu-wasm32-asyncify/core.wasm.gz`, helpersPath: `stable-diffusion-cpp-runtime/${'a'.repeat(40)}/examples/runtime/index.mjs`, schemaSha256: '1'.repeat(64), wasmBytes: 8, wasmSha256: '0'.repeat(64) }],
} }));
let wrapper: VueWrapper | undefined;
const descriptor = Object.getOwnPropertyDescriptor(navigator, 'gpu');
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.resetAllMocks();
  const file = ggufFile();
  mocks.inspect.mockResolvedValue({ candidates: [{ id: 'model', repositoryId: 'user/model', path: 'model.gguf', files: [{ path: 'model.gguf', file }], size: file.size,
    format: 'gguf', family: 'sd-checkpoint', roles: ['model'], classes: [], evidence: [], variant: 'unknown', turboHint: false, issue: undefined }], issues: [] });
  vi.stubGlobal('isSecureContext', true); vi.stubGlobal('OffscreenCanvas', class {}); vi.stubGlobal('DecompressionStream', class {});
  Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (descriptor) Object.defineProperty(navigator, 'gpu', descriptor); else Reflect.deleteProperty(navigator, 'gpu');
});
async function open({ path }: { path: string }): Promise<Router> {
  // Use the actual file-router record so the alias declaration is exercised.
  const records = routes.filter(route => route.path === '/image-generation');
  expect(records).toHaveLength(1);
  expect(routes.some(route => route.path.startsWith('/image-studio'))).toBe(false);
  expect(records[0]!.alias).toEqual(['/image-generation/diagnostics', '/image-generation/models']);
  const router = createRouter({ history: createMemoryHistory(), routes: records });
  await router.push(path); await router.isReady();
  const surface = defineComponent({ setup() {
    const { active } = useImageGenerationWorkspaceNavigation();
    return () => h('div', [active.value ? h(ImageGenerationSidebar, { navigation: active.value }) : undefined, h(RouterView)]);
  } });
  wrapper = mount(surface, { global: { plugins: [router], stubs: { SidebarDebugControls: true } } });
  await vi.dynamicImportSettled(); await flushPromises(); return router;
}
async function historyStep({ router, delta }: { router: Router, delta: number }): Promise<void> {
  await new Promise<void>(resolve => {
    const stop = router.afterEach(() => {
      stop(); resolve();
    });
    router.go(delta);
  });
  await flushPromises();
}
it('opens the diagnostics URL directly and preserves both forms when navigating through the sidebar', async () => {
  const router = await open({ path: '/image-generation/diagnostics' });
  const owner = wrapper!.getComponent(ImageGenerationLab).vm;
  expect(owner.TEST_ONLY.activeTab.value).toBe('measure');
  expect(wrapper!.get('[data-testid="workspace-nav-diagnostics"]').text()).toBe('Diagnostics');
  expect(wrapper!.find('[data-testid="image-lab-sticky-header"]').exists()).toBe(false);
  expect(wrapper!.find('[data-testid="image-tab-history"]').exists()).toBe(false);
  expect(mocks.create).not.toHaveBeenCalled();
  const push = vi.spyOn(router, 'push');
  await wrapper!.get('[data-testid="workspace-nav-diagnostics"]').trigger('click'); await flushPromises();
  expect(push).not.toHaveBeenCalled();
  owner.TEST_ONLY.benchmark.common.value.prompt = 'shared diagnostic prompt';
  await wrapper!.get('[data-testid="workspace-nav-generate"]').trigger('click'); await flushPromises();
  expect(router.currentRoute.value.path).toBe('/image-generation');
  owner.TEST_ONLY.parameters.value.prompt = 'ordinary prompt';
  await wrapper!.get('[data-testid="workspace-nav-diagnostics"]').trigger('click'); await flushPromises();
  expect(router.currentRoute.value.path).toBe('/image-generation/diagnostics');
  expect(wrapper!.getComponent(ImageGenerationLab).vm.$.uid).toBe(owner.$.uid);
  expect(owner.TEST_ONLY.benchmark.common.value.prompt).toBe('shared diagnostic prompt');
  expect(owner.TEST_ONLY.parameters.value.prompt).toBe('ordinary prompt');
  expect(mocks.dispose).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
});
it('preserves an active benchmark and its retained results across browser back and forward navigation', async () => {
  const pending = Promise.withResolvers<unknown>(); mocks.generate.mockReturnValue(pending.promise);
  const router = await open({ path: '/image-generation' });
  await wrapper!.get('[data-testid="workspace-nav-diagnostics"]').trigger('click'); await flushPromises();
  const owner = wrapper!.getComponent(ImageGenerationLab).vm;
  const bench = owner.TEST_ONLY.benchmark; bench.protocol.value.cooldownSeconds = 0; bench.protocol.value.repeats = 1;
  const operation = bench.start(); await flushPromises();
  expect(mocks.create).toHaveBeenCalledTimes(1);
  await historyStep({ router, delta: -1 });
  expect(owner.TEST_ONLY.activeTab.value).toBe('generate');
  expect(bench.busy.value).toBe(true); expect(mocks.dispose).not.toHaveBeenCalled();
  await owner.TEST_ONLY.generate(); expect(mocks.generate).toHaveBeenCalledTimes(1);
  await historyStep({ router, delta: 1 });
  expect(wrapper!.getComponent(ImageGenerationLab).vm.$.uid).toBe(owner.$.uid);
  pending.resolve({ png: new Blob(['PNG'], { type: 'image/png' }), width: 512, height: 512, modelVersion: 'fixture' });
  await operation; await flushPromises();
  const retained = bench.runs.value[0]!.png;
  expect(retained).toBeInstanceOf(Blob);
  await historyStep({ router, delta: -1 }); await historyStep({ router, delta: 1 });
  expect(wrapper!.getComponent(ImageGenerationLab).vm.$.uid).toBe(owner.$.uid);
  expect(bench.runs.value[0]!.png).toBe(retained);
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.dispose).toHaveBeenCalledTimes(1);
});

it('keeps one owner and form when navigating model management and generation without a legacy-history route', async () => {
  const router = await open({ path: '/image-generation/models' });
  const owner = wrapper!.getComponent(ImageGenerationLab).vm;
  expect(owner.TEST_ONLY.activeTab.value).toBe('models');
  owner.TEST_ONLY.parameters.value.prompt = 'preserve between panes';
  await wrapper!.get('[data-testid="workspace-nav-generate"]').trigger('click'); await flushPromises();
  expect(router.currentRoute.value.path).toBe('/image-generation');
  expect(wrapper!.getComponent(ImageGenerationLab).vm.$.uid).toBe(owner.$.uid);
  await historyStep({ router, delta: -1 });
  expect(owner.TEST_ONLY.activeTab.value).toBe('models');
  expect(owner.TEST_ONLY.parameters.value.prompt).toBe('preserve between panes');
  expect(mocks.create).not.toHaveBeenCalled();
});
