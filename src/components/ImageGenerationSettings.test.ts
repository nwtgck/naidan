import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ImageGenerationSettings from './ImageGenerationSettings.vue';
import { nextTick } from 'vue';

describe('ImageGenerationSettings', () => {
  const defaultProps = {
    canGenerateImage: true,
    isProcessing: false,
    isImageMode: true,
    selectedWidth: 512,
    selectedHeight: 512,
    selectedCount: 1,
    selectedSteps: undefined,
    selectedSeed: undefined,
    selectedPersistAs: 'original' as const,
    availableImageModels: ['model-1'],
    selectedImageModel: 'model-1',
    showHeader: true
  };

  it('renders all resolution presets with labels', () => {
    const wrapper = mount(ImageGenerationSettings, { props: defaultProps });

    const resButtons = wrapper.findAll('button').filter(b => b.classes().includes('font-mono') && b.text().includes('x'));
    expect(resButtons.length).toBe(6);

    // Check for some specific labels
    expect(wrapper.text()).toContain('720p');
    expect(wrapper.text()).toContain('144p');
    expect(wrapper.text()).toContain('4:3');
  });

  it('renders image count presets [1, 5, 10, 50]', () => {
    const wrapper = mount(ImageGenerationSettings, { props: defaultProps });
    const countButtons = wrapper.findAll('button').filter(b => /^(1|5|10|50)$/.test(b.text()));
    expect(countButtons.length).toBe(4);
  });

  it('swaps width and height when swap button is clicked', async () => {
    const wrapper = mount(ImageGenerationSettings, {
      props: { ...defaultProps, selectedWidth: 1280, selectedHeight: 720 }
    });

    const swapButton = wrapper.find('button[title="Swap Width and Height"]');
    await swapButton.trigger('click');

    const emitted = wrapper.emitted('update:resolution');
    expect(emitted).toBeTruthy();
    expect(emitted![0]).toEqual([720, 1280]);
  });

  it('emits update:resolution when a preset is clicked', async () => {
    const wrapper = mount(ImageGenerationSettings, { props: defaultProps });
    const res720p = wrapper.findAll('button').find(b => b.text().includes('1280x720'));
    await res720p?.trigger('click');

    expect(wrapper.emitted('update:resolution')).toContainEqual([1280, 720]);
  });

  it('renders steps input and emits update:steps', async () => {
    const wrapper = mount(ImageGenerationSettings, {
      props: { ...defaultProps, selectedSteps: 20 }
    });

    // const stepsInput = wrapper.find('input[type="number"][title*="steps" i], input[type="number"][placeholder*="steps" i]');
    const allInputs = wrapper.findAll('input[type="number"]');
    // Usually steps is after count
    const input = allInputs.find(i => (i.element as HTMLInputElement).value === '20');
    expect(input?.exists()).toBe(true);

    await input?.setValue(30);
    expect(wrapper.emitted('update:steps')).toContainEqual([30]);
  });

  it('renders seed input and emits update:seed', async () => {
    const wrapper = mount(ImageGenerationSettings, {
      props: { ...defaultProps, selectedSeed: 12345 }
    });

    const allInputs = wrapper.findAll('input[type="number"]');
    const input = allInputs.find(i => (i.element as HTMLInputElement).value === '12345');
    expect(input?.exists()).toBe(true);

    await input?.setValue(54321);
    expect(wrapper.emitted('update:seed')).toContainEqual([54321]);
  });

  it('emits undefined when seed input is cleared', async () => {
    const wrapper = mount(ImageGenerationSettings, {
      props: { ...defaultProps, selectedSeed: 12345 }
    });

    const allInputs = wrapper.findAll('input[type="number"]');
    const input = allInputs.find(i => (i.element as HTMLInputElement).value === '12345');

    await input?.setValue('');
    expect(wrapper.emitted('update:seed')).toContainEqual([undefined]);
  });

  it('emits browser_random when random seed button is clicked', async () => {
    const wrapper = mount(ImageGenerationSettings, {
      props: { ...defaultProps, selectedSeed: undefined }
    });

    const diceButton = wrapper.find('button[title*="random seed" i]');
    expect(diceButton.exists()).toBe(true);

    await diceButton.trigger('click');
    expect(wrapper.emitted('update:seed')).toContainEqual(['browser_random']);
  });

  it('re-enables and focuses seed input when clicking overlay in browser_random mode', async () => {
    const wrapper = mount(ImageGenerationSettings, {
      props: { ...defaultProps, selectedSeed: 'browser_random' },
      attachTo: document.body // Required for testing focus
    });

    const overlay = wrapper.find('.cursor-text');
    expect(overlay.exists()).toBe(true);

    const input = wrapper.find('[data-testid="seed-input"]');
    const inputEl = input.element as HTMLInputElement;
    const focusSpy = vi.spyOn(inputEl, 'focus');

    await overlay.trigger('click');

    // Should emit update:seed with undefined to re-enable
    expect(wrapper.emitted('update:seed')).toContainEqual([undefined]);

    // Focus should be called after nextTick
    await nextTick();
    expect(focusSpy).toHaveBeenCalled();

    wrapper.unmount();
  });
});
