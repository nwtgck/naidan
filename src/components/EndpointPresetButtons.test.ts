import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { ENDPOINT_PRESETS } from '@/constants';
import type { HttpEndpoint } from '@/01-models/types';
import { Secret } from '@/utils/secret';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import EndpointPresetButtons from './EndpointPresetButtons.vue';

enableAutoUnmount(afterEach);

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('EndpointPresetButtons', () => {
  it('shows the existing presets and emits even when the active preset is chosen', async () => {
    const endpoint: HttpEndpoint = { type: 'ollama', url: 'http://localhost:11434', httpHeaders: [['X-Key', Secret.from({ value: 'unchanged' })]] };
    const before = endpoint.httpHeaders?.map(([name, value]) => [name, value.reveal()]);
    const wrapper = mount(EndpointPresetButtons, { props: { endpoint, testIdPrefix: 'preset' } });
    expect(wrapper.findAll('button').map(button => button.text())).toEqual(ENDPOINT_PRESETS.map(preset => preset.name));
    const active = wrapper.get('[data-testid="preset-ollama--local-"]');
    expect(active.attributes('aria-pressed')).toBe('true');
    await active.trigger('click');
    expect(wrapper.emitted('apply')).toEqual([[ENDPOINT_PRESETS[0]]]);
    expect(endpoint).toMatchObject({ type: 'ollama', url: 'http://localhost:11434' });
    expect(endpoint.httpHeaders?.map(([name, value]) => [name, value.reveal()])).toEqual(before);
    await wrapper.setProps({ endpoint: { type: 'llama_cpp_browser' } });
    expect(wrapper.findAll('button').every(button => button.attributes('aria-pressed') === 'false')).toBe(true);
  });

  it('keeps unavailable actions visible without emitting changes', async () => {
    const wrapper = mount(EndpointPresetButtons, { props: { endpoint: { type: 'openai', url: '' }, disabled: true, testIdPrefix: 'preset' } });
    expect(wrapper.findAll('button')).toHaveLength(ENDPOINT_PRESETS.length);
    await wrapper.get('button').trigger('click');
    expect(wrapper.emitted('apply')).toBeUndefined();
  });
});
