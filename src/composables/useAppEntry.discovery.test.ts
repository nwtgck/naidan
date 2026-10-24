import { effectScope, ref, shallowRef, defineComponent } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/01-models/types';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { TEST_ONLY } from './useAppEntry';

const mocks = vi.hoisted(() => ({ load: vi.fn(), addToast: vi.fn() }));
vi.mock('@/utils/module-loader', () => ({ createModuleLoader: () => ({ load: mocks.load, prefetch: async () => {} }) }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({}) }));
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ addToast: mocks.addToast }) }));

beforeEach(async () => {
  vi.clearAllMocks();
  await ensureAllStringsForTest({ locale: 'en' });
});

async function harness() {
  const page = defineComponent({ template: '<div />' });
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: page }] });
  await router.push('/');
  const scope = effectScope();
  let storageCurrent = true;
  const entry = scope.run(() => TEST_ONLY.createAppEntry({
    router,
    startupState: shallowRef({ kind: 'ready', mainApp: page }),
    settingsInitialized: ref(true),
    settings: ref({ ...DEFAULT_SETTINGS, endpoint: { type: 'llama_cpp_browser' as const }, defaultModelId: 'selected-model' }),
    captureStorage: () => () => storageCurrent,
    captureModelLaunchDefaults: async () => undefined,
    readHistoryEmpty: async () => true,
    deferModelRefresh: () => {},
    resumeModelRefresh: () => {},
  }))!;
  entry.openModelSelection({ target: { kind: 'home' }, selection: entry.homeSelection.value, opener: undefined });
  return {
    entry,
    router,
    retireStorage: () => {
      storageCurrent = false;
    },
    [Symbol.dispose]() {
      scope.stop();
    },
  };
}

it('keeps the original dialog usable while loading and after failure, then retries only its UI', async () => {
  using owner = await harness();
  const pending = Promise.withResolvers<unknown>();
  mocks.load.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ default: defineComponent({ template: '<div />' }) });
  const opening = owner.entry.openDiscovery({ tab: 'candidates' });
  expect(owner.entry.discovery.value).toBeUndefined();
  expect(owner.entry.modelSelection.value?.phase).toBe('open');
  pending.reject(new Error('UI chunk unavailable'));
  await opening;
  expect(owner.entry.discovery.value).toBeUndefined();
  expect(owner.entry.modelSelection.value?.phase).toBe('open');
  expect(mocks.addToast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Could not open the model browser.', actionLabel: 'Retry' }));
  await mocks.addToast.mock.calls[0]![0].onAction();
  expect(mocks.load).toHaveBeenCalledTimes(2);
  expect(owner.entry.discovery.value?.tab).toBe('candidates');
});

it.each(['dismiss', 'route', 'storage', 'handoff'] as const)('does not open a late panel after its %s changes', async changed => {
  using owner = await harness();
  const pending = Promise.withResolvers<unknown>();
  mocks.load.mockReturnValueOnce(pending.promise);
  if (changed === 'handoff') {
    owner.entry.closeModelSelection();
    owner.entry.finishModelSelectionClose();
  }
  const opening = owner.entry.openDiscovery({ tab: 'hugging-face' });
  switch (changed) {
  case 'dismiss': owner.entry.closeModelSelection();
    break;
  case 'route': await owner.router.push('/chat/other');
    break;
  case 'storage': owner.retireStorage();
    break;
  case 'handoff': {
    const context = owner.entry.captureModelLaunchContext();
    owner.entry.prepareModelLaunchHandoff({ owner: context.owner, chatPath: '/chat/created' });
    await owner.router.push('/chat/created');
    expect(context.isCurrent()).toBe(true);
    break;
  }
  default: {
    const exhaustive: never = changed;
    throw new Error(String(exhaustive));
  }
  }
  pending.resolve({ default: defineComponent({ template: '<div />' }) });
  await opening;
  expect(owner.entry.discovery.value).toBeUndefined();
  expect(mocks.addToast).not.toHaveBeenCalled();
});
