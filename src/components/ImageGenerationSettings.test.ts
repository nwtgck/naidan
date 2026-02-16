import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ImageGenerationSettings from './ImageGenerationSettings.vue';

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

    const stepsInput = wrapper.find('input[type="number"][title*="steps" i], input[type="number"][placeholder*="steps" i]');
    // Note: If title/placeholder is not found, we might need to find by label text or data-testid
    // But let's try to find it among inputs
    const allInputs = wrapper.findAll('input[type="number"]');
    // Usually steps is after count
    const input = allInputs.find(i => i.element.value === '20');
    expect(input?.exists()).toBe(true);

    await input?.setValue(30);
    expect(wrapper.emitted('update:steps')).toContainEqual([30]);
  });

  it('renders seed input and emits update:seed', async () => {
    const wrapper = mount(ImageGenerationSettings, {
      props: { ...defaultProps, selectedSeed: 12345 }
    });

    const allInputs = wrapper.findAll('input[type="number"]');
    const input = allInputs.find(i => i.element.value === '12345');
    expect(input?.exists()).toBe(true);

    await input?.setValue(54321);
    expect(wrapper.emitted('update:seed')).toContainEqual([54321]);
  });

  it('emits undefined when seed input is cleared', async () => {
    const wrapper = mount(ImageGenerationSettings, {
      props: { ...defaultProps, selectedSeed: 12345 }
    });

    const allInputs = wrapper.findAll('input[type="number"]');
    const input = allInputs.find(i => i.element.value === '12345');

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
});
