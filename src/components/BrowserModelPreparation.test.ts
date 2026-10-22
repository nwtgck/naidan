import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import BrowserModelPreparation from './BrowserModelPreparation.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('browser model file selection', () => {
  it.each(['home', 'model-url'] as const)('uses the same post-start presentation for %s without repeating branding or navigation', async entry => {
    const wrapper = mount(BrowserModelPreparation, {
      props: {
        model: { name: 'Example 20B', developer: 'Owner', repository: 'owner/example', bytes: 40000000 },
        entry,
        presentation: 'preparation',
        stage: 'ready',
        interaction: 'ready',
        variant: 'Q4_K_M',
        quantizationOptions: [{ value: 'Q4_K_M', label: 'Q4_K_M', detail: '40 MB' }, { value: 'Q8_0', label: 'Q8_0', detail: '80 MB' }],
        startStatus: 'idle',
        error: undefined,
        selectionState: undefined,
      },
    });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(wrapper.find('[data-testid="model-preparation-brand"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="back-to-model-selection"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-launch-privacy-trigger"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="preparation-model-name"]').text()).toBe('Example 20B');
    const quantization = wrapper.get('[data-testid="model-preview-quantization"]');
    expect(quantization.element.tagName).toBe('SELECT');
    await quantization.setValue('Q8_0');
    expect(wrapper.emitted('select-quantization')).toEqual([['Q8_0']]);
    await wrapper.setProps({ presentation: 'preview' });
    expect(wrapper.find('[data-testid="model-preparation-brand"]').exists()).toBe(true);
  });

  it('keeps Back available while the download operation is busy', async () => {
    const wrapper = mount(BrowserModelPreparation, {
      props: {
        model: { name: 'Example', developer: 'Owner', repository: 'owner/example', bytes: 100 },
        entry: 'home',
        stage: 'download',
        interaction: 'ready',
        variant: 'Q4_K_M',
        quantizationOptions: [],
        startStatus: 'starting',
        error: undefined,
        selectionState: undefined,
      },
    });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const back = wrapper.get('[data-testid="back-to-model-selection"]');
    expect(wrapper.get('[data-testid="browser-model-preparation"]').attributes('inert')).toBeUndefined();
    expect(back.attributes('disabled')).toBeUndefined();
    await wrapper.setProps({ interaction: 'blocked' });
    expect(wrapper.get('[data-testid="browser-model-preparation"]').attributes('inert')).toBeDefined();
    expect(back.attributes('disabled')).toBeDefined();
    await wrapper.setProps({ interaction: 'ready' });
    expect(wrapper.get('[data-testid="browser-model-preparation"]').attributes('inert')).toBeUndefined();
    await back.trigger('click');
    expect(wrapper.emitted('back')).toHaveLength(1);
  });

  it('confirms exact main and companion paths without choosing an ambiguous first file', async () => {
    const operation = Symbol('selection');
    const wrapper = mount(BrowserModelPreparation, {
      props: {
        model: { name: 'Example', developer: 'Owner', repository: 'owner/example', bytes: undefined },
        entry: 'model-url',
        stage: 'needs-selection',
        interaction: 'ready',
        variant: 'Q4_K_M',
        quantizationOptions: [],
        startStatus: 'idle',
        error: undefined,
        selectionState: { status: 'needs-selection', operation, input: 'owner/example', mainChoices: [{ path: 'base/Q4_K_M.gguf', label: 'Base Q4_K_M', size: 100 }, { path: 'other/Q4_K_M.gguf', label: 'Other Q4_K_M', size: 200 }], companionChoices: [{ path: 'vision-a.gguf', label: 'Vision A', size: 10 }, { path: 'vision-b.gguf', label: 'Vision B', size: 20 }], selectedMainPath: undefined, selectedCompanionPath: undefined, companionRequirement: 'required' },
      },
    });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(wrapper.get('[data-testid="model-launch-confirm-selection"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="model-launch-main-file"]').setValue('other/Q4_K_M.gguf');
    expect(wrapper.get('[data-testid="model-launch-confirm-selection"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="model-launch-companion-file"]').setValue('vision-b.gguf');
    await wrapper.get('[data-testid="model-launch-confirm-selection"]').trigger('click');
    expect(wrapper.emitted('confirm-selection')).toEqual([[{ operation, mainFilePath: 'other/Q4_K_M.gguf', companionFilePath: 'vision-b.gguf' }]]);
  });

  it('allows another quantization after preparation and locks it during transfer', async () => {
    const wrapper = mount(BrowserModelPreparation, {
      global: { stubs: { Teleport: true } },
      props: {
        model: { name: 'Example', developer: 'Owner', repository: 'owner/example', bytes: 40000000 },
        entry: 'model-url',
        stage: 'ready',
        interaction: 'ready',
        variant: 'Q4_K_M',
        quantizationOptions: [{ value: 'Q4_K_M', label: 'Q4_K_M', detail: '40 MB' }, { value: 'Q8_0', label: 'Q8_0', detail: '80 MB' }],
        startStatus: 'idle',
        error: undefined,
        selectionState: undefined,
      },
    });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const control = wrapper.get('[data-testid="model-preview-quantization"]');
    expect(control.attributes('disabled')).toBeUndefined();
    await control.setValue('Q8_0');
    expect(wrapper.emitted('select-quantization')).toEqual([['Q8_0']]);
    await wrapper.setProps({ stage: 'download' });
    expect(control.attributes('disabled')).toBeDefined();
  });
});
