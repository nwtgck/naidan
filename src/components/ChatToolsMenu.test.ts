import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, VueWrapper } from '@vue/test-utils';
import ChatToolsMenu from './ChatToolsMenu.vue';
import { ref, nextTick } from 'vue';

// Mock @vueuse/core for positioning tests
const mockBounding = {
  top: ref(100),
  bottom: ref(140),
  left: ref(100),
  width: ref(40),
};
const mockWindowSize = {
  width: ref(1024),
  height: ref(768),
};

vi.mock('@vueuse/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vueuse/core')>();
  return {
    ...actual,
    useElementBounding: vi.fn(() => mockBounding),
    useWindowSize: vi.fn(() => mockWindowSize),
  };
});

describe('ChatToolsMenu', () => {
  const defaultProps = {
    canGenerateImage: true,
    isProcessing: false,
    isImageMode: false,
    selectedWidth: 512,
    selectedHeight: 512,
    selectedCount: 1,
    selectedSteps: undefined,
    selectedSeed: undefined,
    selectedPersistAs: 'original' as const,
    availableImageModels: ['model-1', 'model-2'],
    selectedImageModel: 'model-1'
  };

  let wrapper: VueWrapper<any>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBounding.top.value = 100;
    mockBounding.bottom.value = 140;
    mockBounding.left.value = 100;
    mockBounding.width.value = 40;
    mockWindowSize.width.value = 1024;
    mockWindowSize.height.value = 768;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount();
    }
    document.body.innerHTML = '';
  });

  it('renders the tools button', () => {
    wrapper = mount(ChatToolsMenu, { props: defaultProps });
    expect(wrapper.find('[data-testid="chat-tools-button"]').exists()).toBe(true);
  });

  it('toggles menu on click', async () => {
    wrapper = mount(ChatToolsMenu, {
      props: defaultProps,
      attachTo: document.body
    });
    const button = wrapper.find('[data-testid="chat-tools-button"]');

    await button.trigger('click');
    await flushPromises();
    await vi.dynamicImportSettled();

    // Teleported to body
    expect(document.body.textContent).toContain('Experimental Tools');

    await button.trigger('click');
    await flushPromises();
    expect(document.body.querySelector('[data-testid="chat-tools-dropdown"]')).toBeFalsy();
  });

  it('emits toggle-image-mode when clicking the image mode button', async () => {
    wrapper = mount(ChatToolsMenu, {
      props: defaultProps,
      attachTo: document.body
    });
    await wrapper.find('[data-testid="chat-tools-button"]').trigger('click');
    await flushPromises();
    await vi.dynamicImportSettled();

    const toggleButton = document.body.querySelector('[data-testid="toggle-image-mode-button"]') as HTMLElement;
    toggleButton.click();

    expect(wrapper.emitted('toggle-image-mode')).toBeTruthy();
  });

  it('shows resolution, count and model selectors when image mode is on', async () => {
    wrapper = mount(ChatToolsMenu, {
      props: { ...defaultProps, isImageMode: true },
      attachTo: document.body
    });
    await wrapper.find('[data-testid="chat-tools-button"]').trigger('click');
    await flushPromises();
    await vi.dynamicImportSettled();

    expect(document.body.textContent).toContain('Image Model');
    expect(document.body.textContent).toContain('Resolution');
    expect(document.body.textContent).toContain('Number of Images');
    expect(document.body.textContent).toContain('Save Format');

    const resButtons = Array.from(document.body.querySelectorAll('button')).filter(b => b.classList.contains('font-mono') && b.textContent?.includes('x'));
    expect(resButtons.length).toBe(6);

    const countButtons = Array.from(document.body.querySelectorAll('button')).filter(b => /^(1|5|10|50)$/.test(b.textContent || ''));
    expect(countButtons.length).toBe(4); // 1, 5, 10, 50

    const formatButtons = Array.from(document.body.querySelectorAll('button')).filter(b => ['Original', 'WebP', 'JPEG', 'PNG'].includes(b.textContent || ''));
    expect(formatButtons.length).toBe(4);
  });

  it('emits update:resolution when a resolution is selected', async () => {
    wrapper = mount(ChatToolsMenu, {
      props: { ...defaultProps, isImageMode: true },
      attachTo: document.body
    });
    await wrapper.find('[data-testid="chat-tools-button"]').trigger('click');
    await flushPromises();
    await vi.dynamicImportSettled();

    const res256 = Array.from(document.body.querySelectorAll('button')).find(b => b.textContent?.includes('256x256'));
    res256?.click();

    expect(wrapper.emitted('update:resolution')).toEqual([[256, 256]]);
  });

  it('emits update:resolution when a custom resolution is entered', async () => {
    wrapper = mount(ChatToolsMenu, {
      props: { ...defaultProps, isImageMode: true },
      attachTo: document.body
    });
    await wrapper.find('[data-testid="chat-tools-button"]').trigger('click');
    await flushPromises();
    await vi.dynamicImportSettled();

    const widthInput = document.body.querySelector('input[placeholder="Width"]') as HTMLInputElement;
    const heightInput = document.body.querySelector('input[placeholder="Height"]') as HTMLInputElement;

    widthInput.value = '800';
    widthInput.dispatchEvent(new Event('input'));
    expect(wrapper.emitted('update:resolution')).toContainEqual([800, 512]);

    await wrapper.setProps({ selectedWidth: 800 });

    heightInput.value = '600';
    heightInput.dispatchEvent(new Event('input'));
    expect(wrapper.emitted('update:resolution')).toContainEqual([800, 600]);
  });

  it('emits update:count when a count is selected', async () => {
    wrapper = mount(ChatToolsMenu, {
      props: { ...defaultProps, isImageMode: true },
      attachTo: document.body
    });
    await wrapper.find('[data-testid="chat-tools-button"]').trigger('click');
    await flushPromises();
    await vi.dynamicImportSettled();

    const count5 = Array.from(document.body.querySelectorAll('button')).find(b => b.textContent === '5');
    count5?.click();

    expect(wrapper.emitted('update:count')).toEqual([[5]]);
  });

  it('emits update:count when a custom count is entered', async () => {
    wrapper = mount(ChatToolsMenu, {
      props: { ...defaultProps, isImageMode: true },
      attachTo: document.body
    });
    await wrapper.find('[data-testid="chat-tools-button"]').trigger('click');
    await flushPromises();
    await vi.dynamicImportSettled();

    const input = document.body.querySelector('input[placeholder="Qty"]') as HTMLInputElement;
    input.value = '10';
    input.dispatchEvent(new Event('input'));

    expect(wrapper.emitted('update:count')).toEqual([[10]]);
  });

  it('emits update:persist-as when a format is selected', async () => {
    wrapper = mount(ChatToolsMenu, {
      props: { ...defaultProps, isImageMode: true },
      attachTo: document.body
    });
    await wrapper.find('[data-testid="chat-tools-button"]').trigger('click');
    await flushPromises();
    await vi.dynamicImportSettled();

    const webpBtn = Array.from(document.body.querySelectorAll('button')).find(b => b.textContent === 'WebP');
    webpBtn?.click();

    expect(wrapper.emitted('update:persist-as')).toEqual([['webp']]);
  });

  it('shows empty state when no tools are available', async () => {
    wrapper = mount(ChatToolsMenu, {
      props: { ...defaultProps, canGenerateImage: false },
      attachTo: document.body
    });
    await wrapper.find('[data-testid="chat-tools-button"]').trigger('click');
    await flushPromises();
    await vi.dynamicImportSettled();

    expect(document.body.textContent).toContain('No tools available for this provider');
  });

  describe('Adaptive Positioning Features', () => {
    it('shifts left if the menu would overflow the right edge', async () => {
      // Trigger near the right edge (window width 1024, menu width 256)
      mockBounding.left.value = 900;
      mockWindowSize.width.value = 1024;

      wrapper = mount(ChatToolsMenu, {
        props: defaultProps,
        attachTo: document.body
      });
      await wrapper.find('[data-testid="chat-tools-button"]').trigger('click');
      await flushPromises();

      const dropdown = document.body.querySelector('[data-testid="chat-tools-dropdown"]') as HTMLElement;
      const leftValue = parseFloat(dropdown.style.left);
      const menuWidth = 256;

      // Should be shifted left to stay on screen (1024 - 256 - 16 = 752)
      expect(leftValue).toBeLessThan(900);
      expect(leftValue + menuWidth).toBeLessThanOrEqual(mockWindowSize.width.value - 16);
      expect(leftValue).toBe(1024 - 256 - 16);
    });

    it('respects the 16px left margin', async () => {
      // Trigger near the left edge
      mockBounding.left.value = 5;

      wrapper = mount(ChatToolsMenu, {
        props: defaultProps,
        attachTo: document.body
      });
      await wrapper.find('[data-testid="chat-tools-button"]').trigger('click');
      await flushPromises();

      const dropdown = document.body.querySelector('[data-testid="chat-tools-dropdown"]') as HTMLElement;
      const leftValue = parseFloat(dropdown.style.left);

      expect(leftValue).toBe(16);
    });

    it('positions upward when direction is up', async () => {
      mockBounding.top.value = 500;
      mockWindowSize.height.value = 768;

      wrapper = mount(ChatToolsMenu, {
        props: { ...defaultProps, direction: 'up' },
        attachTo: document.body
      });
      await wrapper.find('[data-testid="chat-tools-button"]').trigger('click');
      await flushPromises();

      const dropdown = document.body.querySelector('[data-testid="chat-tools-dropdown"]') as HTMLElement;
      expect(dropdown.style.bottom).not.toBe('auto');
      expect(dropdown.style.top).toBe('auto');

      // bottom = windowHeight - rect.top + margin = 768 - 500 + 8 = 276
      expect(parseFloat(dropdown.style.bottom)).toBe(276);
    });

    it('positions downward when direction is down', async () => {
      mockBounding.bottom.value = 140;

      wrapper = mount(ChatToolsMenu, {
        props: { ...defaultProps, direction: 'down' },
        attachTo: document.body
      });
      await wrapper.find('[data-testid="chat-tools-button"]').trigger('click');
      await flushPromises();

      const dropdown = document.body.querySelector('[data-testid="chat-tools-dropdown"]') as HTMLElement;
      expect(dropdown.style.top).not.toBe('auto');
      expect(dropdown.style.bottom).toBe('auto');

      // top = rect.bottom + margin = 140 + 8 = 148
      expect(parseFloat(dropdown.style.top)).toBe(148);
    });

    it('closes on window width resize', async () => {
      wrapper = mount(ChatToolsMenu, {
        props: defaultProps,
        attachTo: document.body
      });
      await wrapper.find('[data-testid="chat-tools-button"]').trigger('click');
      await flushPromises();

      expect(document.body.querySelector('[data-testid="chat-tools-dropdown"]')).toBeTruthy();

      // Width change
      mockWindowSize.width.value = 800;
      await nextTick();
      await flushPromises();

      expect(document.body.querySelector('[data-testid="chat-tools-dropdown"]')).toBeFalsy();
    });
  });
});
