import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { ref, type Ref } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import type { useSettings } from '@/composables/useSettings';
import {
  applyInitialGlobalSettingsQuery,
  installGlobalSettingsQuerySync,
} from '@/services/global-settings-query';
import type { HttpEndpoint, Settings } from '@/models/types';

type SettingsStore = ReturnType<typeof useSettings>;

type TestGlobalSettings = {
  endpoint: HttpEndpoint,
  defaultModelId: string,
};


describe('global settings query sync', () => {
  let router: Router;
  let dispose: (() => void) | undefined;
  let settings: Ref<TestGlobalSettings>;
  let save: ReturnType<typeof vi.fn>;
  let settingsStore: SettingsStore;

  beforeEach(async () => {
    settings = ref({
      endpoint: { type: 'openai', url: '' },
      defaultModelId: '',
    });
    save = vi.fn(async ({ patch }: { patch: Partial<Settings> }) => {
      settings.value = {
        endpoint: patch.endpoint === undefined
          ? settings.value.endpoint
          : patch.endpoint as HttpEndpoint,
        defaultModelId: patch.defaultModelId ?? settings.value.defaultModelId,
      };
    });
    settingsStore = {
      save,
    } as unknown as SettingsStore;

    router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    });
    await router.push('/');
    await router.isReady();

    const initialFingerprint = await applyInitialGlobalSettingsQuery({
      query: router.currentRoute.value.query,
      settingsStore,
    });
    dispose = installGlobalSettingsQuerySync({
      router,
      settingsStore,
      initialFingerprint,
    });
  });

  afterEach(() => {
    dispose?.();
  });

  function onboardingIsDismissed(): boolean {
    return settings.value.endpoint.url.length > 0
      && settings.value.defaultModelId.length > 0;
  }

  it('hides onboarding when both endpoint and model are provided in query', async () => {
    await router.push({
      path: '/',
      query: {
        'global-endpoint-type': 'ollama',
        'global-endpoint-url': 'http://localhost:11434',
        'global-model': 'llama3',
      },
    });
    await flushPromises();

    expect(onboardingIsDismissed()).toBe(true);
  });

  it('keeps onboarding when only endpoint is provided', async () => {
    await router.push({
      path: '/',
      query: {
        'global-endpoint-type': 'ollama',
        'global-endpoint-url': 'http://localhost:11434',
      },
    });
    await flushPromises();

    expect(onboardingIsDismissed()).toBe(false);
  });

  it('ignores an invalid endpoint type instead of applying an unvalidated setting', async () => {
    await router.push({
      path: '/',
      query: {
        'global-endpoint-type': 'unsupported',
        'global-endpoint-url': 'http://localhost:11434',
      },
    });
    await flushPromises();

    expect(settings.value.endpoint).toEqual({ type: 'openai', url: '' });
    expect(save).not.toHaveBeenCalled();
  });

  it('syncs global endpoint settings from query parameters', async () => {
    await router.push({
      path: '/',
      query: {
        'global-endpoint-type': 'ollama',
        'global-endpoint-url': 'http://localhost:11434',
      },
    });
    await flushPromises();

    expect(settings.value.endpoint).toEqual({
      type: 'ollama',
      url: 'http://localhost:11434',
    });
    expect(save).toHaveBeenLastCalledWith({
      patch: {
        endpoint: { type: 'ollama', url: 'http://localhost:11434' },
      },
      modelRefresh: 'background',
    });
  });

  it('syncs global model from query parameters', async () => {
    await router.push({
      path: '/',
      query: {
        'global-model': 'llama3',
      },
    });
    await flushPromises();

    expect(settings.value.defaultModelId).toBe('llama3');
  });

  it('syncs endpoint and model in one persisted patch', async () => {
    await router.push({
      path: '/',
      query: {
        'global-endpoint-type': 'openai',
        'global-endpoint-url': 'https://api.openai.com/v1',
        'global-model': 'gpt-4',
      },
    });
    await flushPromises();

    expect(settings.value.endpoint).toEqual({
      type: 'openai',
      url: 'https://api.openai.com/v1',
    });
    expect(settings.value.defaultModelId).toBe('gpt-4');
    expect(save).toHaveBeenLastCalledWith({
      patch: {
        endpoint: { type: 'openai', url: 'https://api.openai.com/v1' },
        defaultModelId: 'gpt-4',
      },
      modelRefresh: 'background',
    });
  });
});
