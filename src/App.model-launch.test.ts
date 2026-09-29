import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, ref, shallowRef } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import type { StartupState } from '@/logic/startup/types';
import App from './App.vue';
import ModelLaunchEntry from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelLaunchEntry.vue';
const initialized = ref(true);
const isOnboardingDismissed = ref(false);
const settings = ref<Settings>({ ...DEFAULT_SETTINGS, endpoint: { type: 'openai', url: '' }, storageType: 'memory' });
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ initialized, isOnboardingDismissed, settings }) }));
vi.mock('@/features/file-protocol-standalone/composables/usePortableAppDownload', () => ({ usePortableAppDownload: () => ({}) }));
vi.mock('@/components/OnboardingModal.vue', () => ({ default: { template: '<div data-testid="onboarding-modal" />' } }));
vi.mock('@/components/GlobalDialogHost.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/ToastContainer.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/startup/StartupErrorView.vue', () => ({ default: { template: '<div />' } }));
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' }); isOnboardingDismissed.value = false;
});
describe('first-use embedded model launcher', () => {
  it.each([false, true])('renders the real WelcomeScreen entry without mounting onboarding (dismissed=%s)', async dismissed => {
    isOnboardingDismissed.value = dismissed;
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: ModelLaunchEntry }] });
    await router.push('/?llama-cpp-browser-model=hf.co/owner/Model-GGUF:Q4_K_M');
    const MainApp = defineComponent({ template: '<router-view />' });
    const startupState = shallowRef<StartupState>({ kind: 'ready', mainApp: MainApp });
    const wrapper = mount(App, { props: { startupState }, global: { plugins: [router] } });
    await flushPromises();
    expect(wrapper.find('[data-testid="model-launch-entry"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="app-content-host"]').attributes('inert')).toBeUndefined();
    expect(wrapper.find('[data-testid="app-content-host"]').attributes('aria-hidden')).toBeUndefined();
    expect(isOnboardingDismissed.value).toBe(dismissed);
    wrapper.unmount();
  });
});
