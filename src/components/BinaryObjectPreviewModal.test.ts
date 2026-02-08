import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import BinaryObjectPreviewModal from './BinaryObjectPreviewModal.vue';
import { storageService } from '../services/storage';
import type { BinaryObject } from '../models/types';

// --- Mocks ---

vi.mock('../services/storage', () => ({
  storageService: {
    getFile: vi.fn(),
  },
}));

// Mock URL.createObjectURL and URL.revokeObjectURL
vi.stubGlobal('URL', {
  createObjectURL: vi.fn(() => 'blob:mock-url'),
  revokeObjectURL: vi.fn(),
});

// --- Test Data ---

const mockObjects: BinaryObject[] = [
  { id: '1', name: 'image1.png', mimeType: 'image/png', size: 1024, createdAt: 1000 },
  { id: '2', name: 'image2.jpg', mimeType: 'image/jpeg', size: 2048, createdAt: 2000 },
  { id: '3', name: 'doc.pdf', mimeType: 'application/pdf', size: 512, createdAt: 500 },
];

const globalStubs = {
  Teleport: true,
  X: true, Download: true, Trash2: true, ChevronLeft: true, ChevronRight: true, 
  ZoomIn: true, ZoomOut: true, Copy: true, Check: true, File: true, Eye: true, 
  RefreshCw: true, Calendar: true, Info: true
};

describe('BinaryObjectPreviewModal.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['mock data'], { type: 'image/png' }));
  });

  const mountModal = (initialId = '1') => {
    return mount(BinaryObjectPreviewModal, {
      props: {
        objects: mockObjects,
        initialId,
      },
      global: {
        stubs: globalStubs,
      },
    });
  };

  it('renders initial object correctly', async () => {
    const wrapper = mountModal('1');
    await flushPromises();
    
    expect(wrapper.get('[data-testid="preview-filename"]').text()).toContain('image1.png');
    expect(wrapper.get('[data-testid="preview-mimetype"]').text()).toBe('image/png');
    expect(wrapper.get('[data-testid="preview-size"]').text()).toBe('1 KB');
    expect(storageService.getFile).toHaveBeenCalledWith('1');
  });

  it('navigates to next object with button', async () => {
    const wrapper = mountModal('1');
    await flushPromises();
    
    const nextBtn = wrapper.get('[data-testid="preview-next-btn"]');
    await nextBtn.trigger('click');
    
    await flushPromises();
    await vi.runAllTimersAsync();
    await flushPromises();
    
    expect(wrapper.get('[data-testid="preview-filename"]').text()).toContain('image2.jpg');
    expect(storageService.getFile).toHaveBeenCalledWith('2');
  });

  it('navigates to next object with keyboard', async () => {
    const wrapper = mountModal('1');
    await flushPromises();
    
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    
    await flushPromises();
    await vi.runAllTimersAsync();
    await flushPromises();
    
    expect(wrapper.get('[data-testid="preview-filename"]').text()).toContain('image2.jpg');
  });

  it('navigates to previous object with keyboard', async () => {
    const wrapper = mountModal('2');
    await flushPromises();
    
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    
    await flushPromises();
    await vi.runAllTimersAsync();
    await flushPromises();
    
    expect(wrapper.get('[data-testid="preview-filename"]').text()).toContain('image1.png');
  });

  it('closes on Escape key', async () => {
    const wrapper = mountModal('1');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(wrapper.emitted()).toHaveProperty('close');
  });

  it('zooms in and out with wheel', async () => {
    const wrapper = mountModal('1');
    await flushPromises();
    
    const container = wrapper.find('.w-full.h-full.p-0');
    
    // Zoom in
    await container.trigger('wheel', { deltaY: -100 });
    expect((wrapper.vm as any).zoom).toBeGreaterThan(1);
    
    const oldZoom = (wrapper.vm as any).zoom;
    
    // Zoom out
    await container.trigger('wheel', { deltaY: 100 });
    expect((wrapper.vm as any).zoom).toBeLessThan(oldZoom);
  });

  it('performs focal-point zooming relative to mouse position', async () => {
    const wrapper = mountModal('1');
    await flushPromises();
    
    const container = wrapper.find('.w-full.h-full.p-0');
    
    // Mock getBoundingClientRect for the container
    vi.spyOn(container.element, 'getBoundingClientRect').mockReturnValue({
      width: 1000,
      height: 1000,
      left: 0,
      top: 0,
    } as DOMRect);

    // Directly call handleWheel to bypass event property read-only issues in test-utils
    const event = {
      deltaY: -100,
      clientX: 250,
      clientY: 250,
      preventDefault: vi.fn(),
      currentTarget: container.element
    };
    
    (wrapper.vm as any).handleWheel(event as any);

    const newZoom = (wrapper.vm as any).zoom;
    const newPos = (wrapper.vm as any).position;
    
    expect(newZoom).toBeCloseTo(1.1);
    
    // Logic Verification:
    // oldZoom = 1.0, newZoom = 1.1, rect = 1000x1000
    // mouseX = 250, mouseY = 250
    // relativeX = mouseX - 500 - 0 = -250
    // ratio = 1.1
    // newPosX = 250 - 500 - (-250 * 1.1) = -250 + 275 = 25
    expect(newPos.x).toBeCloseTo(25);
    expect(newPos.y).toBeCloseTo(25);
  });

  it('drags image when zoomed', async () => {
    const wrapper = mountModal('1');
    await flushPromises();
    
    const container = wrapper.find('.w-full.h-full.p-0');
    (wrapper.vm as any).zoom = 2; // Must be zoomed to drag
    
    await container.trigger('mousedown', { clientX: 100, clientY: 100 });
    await container.trigger('mousemove', { clientX: 150, clientY: 120 });
    await container.trigger('mouseup');
    
    expect((wrapper.vm as any).position).toEqual({ x: 50, y: 20 });
  });

  it('respects zoom limits', async () => {
    const wrapper = mountModal('1');
    await flushPromises();
    
    const container = wrapper.find('.w-full.h-full.p-0');
    
    // Zoom out many times
    for (let i = 0; i < 50; i++) {
      await container.trigger('wheel', { deltaY: 100 });
    }
    expect((wrapper.vm as any).zoom).toBeCloseTo(0.1);
    
    // Zoom in many times
    for (let i = 0; i < 100; i++) {
      await container.trigger('wheel', { deltaY: -100 });
    }
    expect((wrapper.vm as any).zoom).toBe(20);
  });

  it('resets zoom and position when navigating', async () => {
    const wrapper = mountModal('1');
    await flushPromises();
    
    (wrapper.vm as any).zoom = 2;
    (wrapper.vm as any).position = { x: 100, y: 100 };
    
    await wrapper.get('[data-testid="preview-next-btn"]').trigger('click');
    await flushPromises();
    await vi.runAllTimersAsync();
    
    expect((wrapper.vm as any).zoom).toBe(1);
    expect((wrapper.vm as any).position).toEqual({ x: 0, y: 0 });
  });

  it('does not navigate past boundaries', async () => {
    const wrapper = mountModal('1');
    await flushPromises();
    
    // Prev at start
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    await flushPromises();
    expect((wrapper.vm as any).currentIndex).toBe(0);
    
    // Jump to end
    (wrapper.vm as any).currentIndex = mockObjects.length - 1;
    await nextTick();
    
    // Next at end
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await flushPromises();
    expect((wrapper.vm as any).currentIndex).toBe(mockObjects.length - 1);
  });

  it('resets zoom with button', async () => {
    const wrapper = mountModal('1');
    await flushPromises();
    
    (wrapper.vm as any).zoom = 2;
    const resetBtn = wrapper.get('[data-testid="preview-zoom-reset-btn"]');
    await resetBtn.trigger('click');
    
    expect((wrapper.vm as any).zoom).toBe(1);
  });

  it('copies filename to clipboard', async () => {
    const mockClipboard = {
      writeText: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal('navigator', { clipboard: mockClipboard });
    
    const wrapper = mountModal('1');
    await flushPromises();
    
    const copyBtn = wrapper.get('[data-testid="preview-copy-name-btn"]');
    await copyBtn.trigger('click');
    
    expect(mockClipboard.writeText).toHaveBeenCalledWith('image1.png');
    
    await nextTick();
    expect(wrapper.find('[data-testid="icon-check"]').exists()).toBe(true);
    
    vi.advanceTimersByTime(2000);
    await nextTick();
    expect(wrapper.find('[data-testid="icon-copy"]').exists()).toBe(true);
  });

  it('emits delete event', async () => {
    const wrapper = mountModal('1');
    const deleteBtn = wrapper.get('[data-testid="preview-delete-btn"]');
    await deleteBtn.trigger('click');
    
    expect(wrapper.emitted('delete')).toBeTruthy();
    expect(wrapper.emitted('delete')![0]).toEqual([mockObjects[0]]);
  });

  it('emits download event', async () => {
    const wrapper = mountModal('1');
    const downloadBtn = wrapper.get('[data-testid="preview-download-btn"]');
    await downloadBtn.trigger('click');
    
    expect(wrapper.emitted('download')).toBeTruthy();
    expect(wrapper.emitted('download')![0]).toEqual([mockObjects[0]]);
  });

  it('hides controls after timeout during zoom', async () => {
    const wrapper = mountModal('1');
    await flushPromises();
    
    // Zoom in to trigger auto-hide logic
    (wrapper.vm as any).zoom = 2;
    (wrapper.vm as any).showControls();
    
    expect((wrapper.vm as any).isControlsVisible).toBe(true);
    
    vi.advanceTimersByTime(3000);
    expect((wrapper.vm as any).isControlsVisible).toBe(false);
    
    // Mouse move should show them again
    const root = wrapper.find('.fixed.inset-0');
    await root.trigger('mousemove');
    expect((wrapper.vm as any).isControlsVisible).toBe(true);
  });

  it('shows non-image placeholder', async () => {
    vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['pdf data'], { type: 'application/pdf' }));
    const wrapper = mountModal('3'); // doc.pdf
    await flushPromises();
    await vi.runAllTimersAsync();
    await flushPromises();
    
    expect(wrapper.text()).toContain('Preview Unavailable');
  });
});
