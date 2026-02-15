import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ImageEditor from './ImageEditor.vue';
import { nextTick } from 'vue';

// Mock Lucide icons
vi.mock('lucide-vue-next', () => ({
  X: { template: '<span>X</span>' },
  Check: { template: '<span>Check</span>' },
  RotateCw: { template: '<span>RotateCw</span>' },
  FlipHorizontal: { template: '<span>FlipHorizontal</span>' },
  FlipVertical: { template: '<span>FlipVertical</span>' },
  RotateCcw: { template: '<span>RotateCcw</span>' },
  RefreshCcw: { template: '<span>RefreshCcw</span>' },
  Undo2: { template: '<span>Undo2</span>' },
  Redo2: { template: '<span>Redo2</span>' },
  Crop: { template: '<span>Crop</span>' },
  Eraser: { template: '<span>Eraser</span>' },
  Square: { template: '<span>Square</span>' },
  Pencil: { template: '<span>Pencil</span>' },
  PencilOff: { template: '<span>PencilOff</span>' },
  Link: { template: '<span>Link</span>' },
  Link2Off: { template: '<span>Link2Off</span>' },
}));

// Mock HTML5 Canvas and Image
const mockContext = {
  drawImage: vi.fn(),
  getImageData: vi.fn(() => ({ width: 100, height: 100, data: new Uint8ClampedArray(40000) })),
  putImageData: vi.fn(),
  fillRect: vi.fn(),
  clearRect: vi.fn(),
  scale: vi.fn(),
  translate: vi.fn(),
  rotate: vi.fn(),
  setTransform: vi.fn(),
  globalCompositeOperation: 'source-over',
};

// Mocking global Canvas API
// @ts-expect-error - getContext is mocked
HTMLCanvasElement.prototype.getContext = vi.fn(() => mockContext);
// Using any cast to avoid unused directive if the following line is considered error-free in build but not in dev
(HTMLCanvasElement.prototype as any).toBlob = vi.fn((cb) => cb(new Blob()));

describe('ImageEditor', () => {
  const props = {
    imageUrl: 'test-image.jpg',
    fileName: 'test.jpg',
    originalMimeType: 'image/jpeg',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock Image loading
    global.Image = class {
      onload: () => void = () => {};
      src: string = '';
      naturalWidth: number = 100;
      naturalHeight: number = 100;
      constructor() {
        setTimeout(() => this.onload(), 0);
      }
    } as any;
  });

  it('should disable Finish & Apply button when no changes are made', async () => {
    const wrapper = mount(ImageEditor, { props });
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    const applyButton = wrapper.find('button.bg-blue-600');
    expect(applyButton.attributes('disabled')).toBeDefined();
    expect(wrapper.vm.__testOnly.hasChanges.value).toBe(false);
  });

  it('should enable Finish & Apply button when format is changed', async () => {
    const wrapper = mount(ImageEditor, { props });
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    const webpButton = wrapper.findAll('button').find(b => b.text().includes('WebP'));
    await webpButton?.trigger('click');

    const applyButton = wrapper.find('button.bg-blue-600');
    expect(applyButton.attributes('disabled')).toBeUndefined();
    expect(wrapper.vm.__testOnly.hasChanges.value).toBe(true);
  });

  it('should maintain aspect ratio by default during resize', async () => {
    const wrapper = mount(ImageEditor, { props });
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(wrapper.vm.__testOnly.resizeW.value).toBe(100);
    expect(wrapper.vm.__testOnly.resizeH.value).toBe(100);

    wrapper.vm.__testOnly.resizeW.value = 200;
    await nextTick();
    expect(wrapper.vm.__testOnly.resizeH.value).toBe(200);
  });

  it('should allow free resizing when lock is toggled', async () => {
    const wrapper = mount(ImageEditor, { props });
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    wrapper.vm.__testOnly.resizeLock.value = 'free';
    await nextTick();

    wrapper.vm.__testOnly.resizeW.value = 200;
    await nextTick();
    expect(wrapper.vm.__testOnly.resizeH.value).toBe(100);
  });

  it('should enable undo/redo when actions are performed', async () => {
    const wrapper = mount(ImageEditor, { props });
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(wrapper.vm.__testOnly.historyIndex.value).toBe(0);
    await wrapper.vm.__testOnly.applyTransform({ type: 'rotate-r' });
    expect(wrapper.vm.__testOnly.historyIndex.value).toBe(1);

    wrapper.vm.__testOnly.undo();
    expect(wrapper.vm.__testOnly.historyIndex.value).toBe(0);
  });

  it('should execute transform actions (rotate/flip) correctly', async () => {
    const wrapper = mount(ImageEditor, { props });
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    await wrapper.vm.__testOnly.applyTransform({ type: 'rotate-l' });
    expect(mockContext.rotate).toHaveBeenCalled();
    expect(wrapper.vm.__testOnly.historyIndex.value).toBe(1);

    await wrapper.vm.__testOnly.applyTransform({ type: 'flip-h' });
    expect(mockContext.scale).toHaveBeenCalled();
    expect(wrapper.vm.__testOnly.historyIndex.value).toBe(2);
  });

  it('should execute crop action correctly', async () => {
    const wrapper = mount(ImageEditor, { props });
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    await wrapper.vm.__testOnly.executeAction({ action: 'crop' });
    expect(mockContext.getImageData).toHaveBeenCalled();
    expect(wrapper.vm.__testOnly.historyIndex.value).toBe(1);
  });

  it('should execute mask actions with correct composite operation', async () => {
    const wrapper = mount(ImageEditor, { props });
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    wrapper.vm.__testOnly.selectedFill.value = 'transparent';
    await wrapper.vm.__testOnly.executeAction({ action: 'mask-inside' });
    expect(wrapper.vm.__testOnly.historyIndex.value).toBe(1);

    await wrapper.vm.__testOnly.executeAction({ action: 'mask-outside' });
    expect(mockContext.fillRect).toHaveBeenCalled();
    expect(wrapper.vm.__testOnly.historyIndex.value).toBe(2);
  });

  it('should toggle view mode correctly', async () => {
    const wrapper = mount(ImageEditor, { props });
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(wrapper.vm.__testOnly.viewMode.value).toBe('editing');
    await wrapper.vm.__testOnly.toggleViewMode();
    expect(wrapper.vm.__testOnly.viewMode.value).toBe('preview');
  });

  it('should reset editor state correctly', async () => {
    const wrapper = mount(ImageEditor, { props });
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    await wrapper.vm.__testOnly.applyTransform({ type: 'rotate-r' });
    expect(wrapper.vm.__testOnly.historyIndex.value).toBe(1);

    const resetBtn = wrapper.find('button[title="Reset All"]');
    await resetBtn.trigger('click');
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(wrapper.vm.__testOnly.historyIndex.value).toBe(0);
  });
});
