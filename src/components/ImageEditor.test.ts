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
  Circle: { template: '<span>Circle</span>' },
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
  ellipse: vi.fn(),
  beginPath: vi.fn(),
  rect: vi.fn(),
  fill: vi.fn(),
  setTransform: vi.fn(),
  globalCompositeOperation: 'source-over',
  fillStyle: 'black',
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

    const applyButton = wrapper.find('[data-testid="image-editor-finish-button"]');
    expect(applyButton.attributes('disabled')).toBeDefined();
    expect(wrapper.vm.__testOnly.hasChanges.value).toBe(false);
  });

  it('should enable Finish & Apply button when format is changed', async () => {
    const wrapper = mount(ImageEditor, { props });
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    const webpButton = wrapper.findAll('button').find(b => b.text().includes('WebP'));
    await webpButton?.trigger('click');

    const applyButton = wrapper.find('[data-testid="image-editor-finish-button"]');
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

  it('should use opaque fill and reset composite operation when masking with transparent color', async () => {
    const wrapper = mount(ImageEditor, { props });
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    wrapper.vm.__testOnly.selectedFill.value = 'transparent';
    await wrapper.vm.__testOnly.executeAction({ action: 'mask-inside' });

    // Important: fillStyle must be opaque (e.g., 'black') during execution to actually erase pixels in destination-out mode
    // The test confirms that we are not setting it to 'rgba(0,0,0,0)' which was the bug.
    expect(mockContext.fillStyle).toBe('black');

    // Ensure it's reset to source-over after completion
    expect(mockContext.globalCompositeOperation).toBe('source-over');
  });

  it('should have transparency grid background for transparency visualization', async () => {
    const wrapper = mount(ImageEditor, { props });
    await nextTick();

    const workspace = wrapper.find('.bg-transparency-grid');
    expect(workspace.exists()).toBe(true);
    expect(workspace.classes()).toContain('bg-transparency-grid');
  });

  it('should start with no selection', async () => {
    const wrapper = mount(ImageEditor, { props });
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(wrapper.vm.__testOnly.selection.value.status).toBe('none');
  });

  it('should restore selection state when undoing an action', async () => {
    const wrapper = mount(ImageEditor, { props });
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    // 1. Create a selection manually for testing
    wrapper.vm.__testOnly.selection.value.status = 'active';
    wrapper.vm.__testOnly.selection.value.rect = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
    await nextTick();

    // 2. Perform action (Crop) - it should clear the active selection in current view
    await wrapper.vm.__testOnly.executeAction({ action: 'crop' });
    expect(wrapper.vm.__testOnly.selection.value.status).toBe('none');

    // 3. Undo - it should restore the selection that was used for the crop
    wrapper.vm.__testOnly.undo();
    await nextTick();

    expect(wrapper.vm.__testOnly.selection.value.status).toBe('active');
    expect(wrapper.vm.__testOnly.selection.value.rect.x).toBe(0.2);
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

  it('should support elliptical selection and use ellipse path', async () => {
    const wrapper = mount(ImageEditor, { props });
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Switch to ellipse mode
    wrapper.vm.__testOnly.selection.value.shape = 'ellipse';
    await nextTick();

    await wrapper.vm.__testOnly.executeAction({ action: 'mask-inside' });

    expect(mockContext.ellipse).toHaveBeenCalled();
  });

  describe('Direct Manipulation UX', () => {
    it('should start a new selection on mousedown and update on mousemove', async () => {
      const wrapper = mount(ImageEditor, { props });
      await nextTick();
      await new Promise(resolve => setTimeout(resolve, 50));

      const container = wrapper.find('[data-testid="image-editor-container"]');
      expect(container.exists()).toBe(true);

      const canvas = wrapper.find('canvas').element;
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 0, top: 0, width: 100, height: 100,
        bottom: 100, right: 100, x: 0, y: 0,
        toJSON: () => {}
      });

      await container.trigger('mousedown', { clientX: 10, clientY: 10 });
      expect(wrapper.vm.__testOnly.selection.value.status).toBe('active');

      // Simulate mousemove to (50, 50)
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 50 }));
      await nextTick();

      expect(wrapper.vm.__testOnly.selection.value.status).toBe('active');
      // Selection should be visible in DOM
      expect(wrapper.find('[data-testid="image-editor-selection"]').exists()).toBe(true);
    });

    it('should clear selection status after executing an action', async () => {
      const wrapper = mount(ImageEditor, { props });
      await nextTick();

      // Manually set a selection
      wrapper.vm.__testOnly.selection.value.status = 'active';
      await nextTick();

      const cropBtn = wrapper.find('[data-testid="image-editor-action-crop"]');
      await cropBtn.trigger('click');

      expect(wrapper.vm.__testOnly.selection.value.status).toBe('none');
      expect(wrapper.find('[data-testid="image-editor-selection"]').exists()).toBe(false);
    });

    it('should cancel very small selections on mouseup', async () => {
      const wrapper = mount(ImageEditor, { props });
      await nextTick();

      const container = wrapper.find('[data-testid="image-editor-container"]');
      const canvas = wrapper.find('canvas').element;
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 0, top: 0, width: 100, height: 100,
        bottom: 100, right: 100, x: 0, y: 0,
        toJSON: () => {}
      });

      // Start selection
      await container.trigger('mousedown', { clientX: 10, clientY: 10 });

      // Move only 1 pixel (too small)
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 10.1, clientY: 10.1 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
      await nextTick();

      expect(wrapper.vm.__testOnly.selection.value.status).toBe('none');
    });
  });
});
