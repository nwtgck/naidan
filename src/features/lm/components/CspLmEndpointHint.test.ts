import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Endpoint } from '@/01-models/types';
import type { CspHintActivityForDisplayOnly } from '@/components/csp/types';
import { FAKE_LM_ENDPOINT_URL } from '@/features/fake-lm';
import CspLmEndpointHint from './CspLmEndpointHint.vue';

const mocks = vi.hoisted(() => ({
  settings: { value: { experimental: { fakeLm: 'disabled' as 'enabled' | 'disabled' } } },
}));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: mocks.settings }) }));
vi.mock('@/components/csp/CspMessageHint.vue', () => ({
  default: { name: 'CspMessageHint', props: ['target', 'presentation', 'activityForDisplayOnly'], template: '<span data-testid="hint-probe" />' },
}));
vi.mock('@/features/naidan-rpc-integration/components/CspRpcEndpointHint.vue', () => ({
  default: { name: 'CspRpcEndpointHint', props: ['registrationId', 'presentation', 'activityForDisplayOnly'], template: '<span data-testid="relay-hint-probe" />' },
}));

enableAutoUnmount(afterEach);

beforeEach(() => {
  mocks.settings.value.experimental.fakeLm = 'disabled';
});

function renderHint({ endpoint, operation, presentation, activityForDisplayOnly }: {
  endpoint: Endpoint | undefined,
  operation: 'models' | 'chat' | 'image' | 'running-models' | 'unload-model',
  presentation: 'compact' | 'error',
  activityForDisplayOnly: CspHintActivityForDisplayOnly | undefined,
}) {
  return mount(CspLmEndpointHint, { props: { endpoint, operation, presentation, activityForDisplayOnly, fakeLmDebugModeStatus: undefined } });
}

describe('LM endpoint hint transport context', () => {
  it.each([
    { operation: 'models', activity: 'model-list' },
    { operation: 'chat', activity: 'response-generation' },
    { operation: 'image', activity: 'image-generation' },
    { operation: 'running-models', activity: 'running-models' },
    { operation: 'unload-model', activity: 'unload-model' },
  ] as const)('preserves the existing $operation meaning as a display activity', ({ operation, activity }) => {
    const wrapper = renderHint({ endpoint: { type: 'ollama', url: 'https://models.example' }, operation, presentation: 'compact', activityForDisplayOnly: undefined });
    expect(wrapper.getComponent({ name: 'CspMessageHint' }).props('activityForDisplayOnly')).toBe(activity);
    expect(wrapper.emitted()).toEqual({});
  });

  it('lets a field or action override the wording and carries it through RPC without changing the request', async () => {
    const endpoint: Endpoint = { type: 'openai', url: 'https://models.example' };
    const wrapper = renderHint({ endpoint, operation: 'chat', presentation: 'compact', activityForDisplayOnly: 'title-generation' });
    expect(wrapper.getComponent({ name: 'CspMessageHint' }).props()).toEqual({ target: { kind: 'connection', endpoint: endpoint.url, apiPath: '/chat/completions' }, presentation: 'compact', activityForDisplayOnly: 'title-generation' });
    await wrapper.setProps({ endpoint: { type: 'naidan_rpc', registrationId: undefined }, activityForDisplayOnly: 'prompt-translation' });
    expect(wrapper.getComponent({ name: 'CspRpcEndpointHint' }).props()).toEqual({ registrationId: undefined, presentation: 'compact', activityForDisplayOnly: 'prompt-translation' });
    await wrapper.setProps({ operation: 'models', activityForDisplayOnly: 'connection' });
    expect(wrapper.getComponent({ name: 'CspRpcEndpointHint' }).props('activityForDisplayOnly')).toBe('connection');
    expect(endpoint).toEqual({ type: 'openai', url: 'https://models.example' });
    expect(wrapper.emitted()).toEqual({});
  });

  it('contains an unexpected runtime operation in the display adapter', async () => {
    const applicationError = vi.fn();
    const wrapper = mount(CspLmEndpointHint, { props: { endpoint: { type: 'ollama', url: 'https://models.example' }, operation: 'chat', presentation: 'compact', fakeLmDebugModeStatus: undefined, activityForDisplayOnly: undefined }, global: { config: { errorHandler: applicationError } } });
    const context: { operation: 'chat' } = { operation: 'chat' };
    Object.defineProperty(context, 'operation', { value: 'future-private-operation' });
    await wrapper.setProps(context);
    expect(wrapper.find('[data-testid="hint-probe"], [data-testid="relay-hint-probe"]').exists()).toBe(false);
    expect(applicationError).not.toHaveBeenCalled();
    expect(wrapper.emitted()).toEqual({});
  });

  it('keeps the selected endpoint intact for the real provider suffix, without exposing headers', () => {
    const endpoint: Endpoint = { type: 'openai', url: 'https://api.example/v1?mode=demo#section', httpHeaders: [['Authorization', 'secret']] };
    const wrapper = renderHint({ activityForDisplayOnly: undefined, endpoint, operation: 'models', presentation: 'compact' });

    expect(wrapper.getComponent({ name: 'CspMessageHint' }).props()).toEqual({
      target: { kind: 'connection', endpoint: 'https://api.example/v1?mode=demo#section', apiPath: '/models' },
      presentation: 'compact',
      activityForDisplayOnly: 'model-list',
    });
    expect(endpoint).toEqual({ type: 'openai', url: 'https://api.example/v1?mode=demo#section', httpHeaders: [['Authorization', 'secret']] });
  });

  it('distinguishes local Fake LM responses from the same URL used as a network endpoint', async () => {
    const wrapper = renderHint({ activityForDisplayOnly: undefined, endpoint: { type: 'openai', url: FAKE_LM_ENDPOINT_URL }, operation: 'chat', presentation: 'error' });
    expect(wrapper.getComponent({ name: 'CspMessageHint' }).props('target')).toEqual({ kind: 'connection', endpoint: FAKE_LM_ENDPOINT_URL, apiPath: '/chat/completions' });

    await wrapper.setProps({ fakeLmDebugModeStatus: 'enabled' });
    expect(wrapper.getComponent({ name: 'CspMessageHint' }).props('target')).toBeUndefined();
    expect(wrapper.emitted()).toEqual({});
  });

  it('does not describe browser-managed or local execution as an HTTP request', () => {
    const endpoints: Array<Endpoint | undefined> = [
      undefined,
      { type: 'browser_provided_lm' },
      { type: 'llama_cpp_browser' },
      { type: 'transformers_js' },
    ];
    for (const endpoint of endpoints) {
      const wrapper = renderHint({ activityForDisplayOnly: undefined, endpoint, operation: 'models', presentation: 'compact' });
      expect(wrapper.getComponent({ name: 'CspMessageHint' }).props('target')).toBeUndefined();
    }
  });

  it('delegates RPC presentation to its passive registration lookup instead of treating it as HTTP', () => {
    const wrapper = renderHint({ activityForDisplayOnly: undefined, endpoint: { type: 'naidan_rpc', registrationId: undefined }, operation: 'chat', presentation: 'compact' });
    expect(wrapper.findComponent({ name: 'CspMessageHint' }).exists()).toBe(false);
    expect(wrapper.getComponent({ name: 'CspRpcEndpointHint' }).props()).toEqual({ registrationId: undefined, presentation: 'compact', activityForDisplayOnly: 'response-generation' });
    expect(wrapper.emitted()).toEqual({});
  });

  it('forwards the URL-adjacent presentation for both HTTP and RPC without changing transport inputs', async () => {
    const wrapper = renderHint({ activityForDisplayOnly: undefined, endpoint: { type: 'openai', url: 'https://remote.invalid/v1' }, operation: 'models', presentation: 'compact' });
    expect(wrapper.getComponent({ name: 'CspMessageHint' }).props()).toEqual({ target: { kind: 'connection', endpoint: 'https://remote.invalid/v1', apiPath: '/models' }, presentation: 'compact', activityForDisplayOnly: 'model-list' });
    await wrapper.setProps({ endpoint: { type: 'naidan_rpc', registrationId: undefined } });
    expect(wrapper.getComponent({ name: 'CspRpcEndpointHint' }).props()).toEqual({ registrationId: undefined, presentation: 'compact', activityForDisplayOnly: 'model-list' });
    expect(wrapper.emitted()).toEqual({});
  });

  it('uses the actual Ollama operation and retains its relative endpoint', async () => {
    const wrapper = renderHint({ activityForDisplayOnly: undefined, endpoint: { type: 'ollama', url: '/ollama-proxy' }, operation: 'running-models', presentation: 'compact' });
    expect(wrapper.getComponent({ name: 'CspMessageHint' }).props('target')).toEqual({ kind: 'connection', endpoint: '/ollama-proxy', apiPath: '/api/ps' });
    await wrapper.setProps({ operation: 'image' });
    expect(wrapper.getComponent({ name: 'CspMessageHint' }).props('target')).toEqual({ kind: 'connection', endpoint: '/ollama-proxy', apiPath: '/api/generate' });
  });
});
