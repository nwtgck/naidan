import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import BinaryObjectsTab from './BinaryObjectsTab.vue';
import { storageService } from '../services/storage';
import type { BinaryObject } from '../models/types';

// --- Mocks ---

vi.mock('../services/storage', () => ({
  storageService: {
    listBinaryObjects: vi.fn(),
    getFile: vi.fn(),
    deleteBinaryObject: vi.fn(),
  },
}));

const mockShowConfirm = vi.fn();
vi.mock('../composables/useConfirm', () => ({
  useConfirm: vi.fn(() => ({
    showConfirm: mockShowConfirm,
  })),
}));

const mockOpenPreview = vi.fn();
vi.mock('../composables/useImagePreview', () => ({
  useImagePreview: vi.fn(() => ({
    openPreview: mockOpenPreview,
    closePreview: vi.fn(),
  })),
}));

const mockDeleteBinaryObject = vi.fn();
const mockDownloadBinaryObject = vi.fn();
vi.mock('../composables/useBinaryActions', () => ({
  useBinaryActions: vi.fn(() => ({
    deleteBinaryObject: mockDeleteBinaryObject,
    downloadBinaryObject: mockDownloadBinaryObject,
  })),
}));

vi.mock('../composables/useToast', () => ({
  useToast: vi.fn(() => ({
    addToast: vi.fn(),
  })),
}));

// Mock URL.createObjectURL and URL.revokeObjectURL
vi.stubGlobal('URL', {
  createObjectURL: vi.fn(() => 'blob:mock-url'),
  revokeObjectURL: vi.fn(),
});

// Mock requestIdleCallback
vi.stubGlobal('requestIdleCallback', (cb: any) => setTimeout(cb, 1));

// Mock Image
class MockImage {
  onload: () => void = () => {};
  onerror: (e: any) => void = () => {};
  src: string = '';
  width: number = 100;
  height: number = 100;
  constructor() {
    setTimeout(() => this.onload(), 0);
  }
}
vi.stubGlobal('Image', MockImage);

// Mock IntersectionObserver
let observerInstances: MockIntersectionObserver[] = [];
class MockIntersectionObserver {
  callback: IntersectionObserverCallback;
  observe = vi.fn(() => {
    // No-op by default in tests
  });
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observerInstances.push(this);
  }

  // Helper to trigger intersection in tests
  trigger(entries: Partial<IntersectionObserverEntry>[]) {
    this.callback(entries as IntersectionObserverEntry[], this as any);
  }
}
vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

// Spy on document.createElement instead of stubbing entire document
const originalCreateElement = document.createElement.bind(document);
const mockCanvas = {
  getContext: vi.fn(() => ({
    drawImage: vi.fn(),
  })),
  toDataURL: vi.fn(() => 'data:image/jpeg;base64,mock'),
  toBlob: vi.fn((cb) => cb(new Blob(['mock-thumbnail'], { type: 'image/jpeg' }))),
  width: 0,
  height: 0,
};

vi.spyOn(document, 'createElement').mockImplementation((tag) => {
  const el = originalCreateElement(tag);
  if (tag === 'canvas') {
    Object.assign(el, mockCanvas);
    return el as any;
  }
  if (tag === 'a') {
    (el as any).click = vi.fn();
    return el as any;
  }
  return el;
});

// --- Test Data ---

const mockObjects: BinaryObject[] = Array.from({ length: 150 }, (_, i) => ({
  id: `${i + 1}`,
  name: `file${i + 1}.png`,
  mimeType: 'image/png',
  size: 1024,
  createdAt: 1000 + i,
}));

async function* mockAsyncIterable(items: BinaryObject[]) {
  for (const item of items) {
    yield item;
  }
}

const globalStubs = {
  File: true, Search: true, ArrowUp: true, ArrowDown: true, Download: true,
  Eye: true, Calendar: true, HardDrive: true, ChevronRight: true,
  Trash2: true, RefreshCw: true, LayoutGrid: true, List: true, X: true,
  Info: true,
};

describe('BinaryObjectsTab.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(storageService.listBinaryObjects).mockReturnValue(mockAsyncIterable(mockObjects) as any);
    observerInstances = [];
  });

  it('renders correctly, fetches objects, and shows total count', async () => {
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    
    await flushPromises();
    
    expect(wrapper.get('[data-testid="binary-objects-count"]').text()).toContain('150 / 150');
    // Initially renders 60 items due to new displayLimit
    const rows = wrapper.findAll('[data-testid^="binary-object-row-"]');
    expect(rows.length).toBe(60);
  });

  it('implements infinite scroll when sentinel becomes visible', async () => {
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();

    expect(wrapper.findAll('[data-testid^="binary-object-row-"]').length).toBe(60);

    // sentinelObserver is the first one
    observerInstances[0]?.trigger([{ isIntersecting: true }]);
    await nextTick();
    vi.advanceTimersByTime(250); // Wait for guard delay (200ms)

    expect(wrapper.findAll('[data-testid^="binary-object-row-"]').length).toBe(120);
    
    observerInstances[0]?.trigger([{ isIntersecting: true }]);
    await nextTick();
    vi.advanceTimersByTime(250);
    expect(wrapper.findAll('[data-testid^="binary-object-row-"]').length).toBe(150);
  });

  it('allows manual loading by clicking the sentinel', async () => {
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();

    expect(wrapper.findAll('[data-testid^="binary-object-row-"]').length).toBe(60);

    const loadMoreBtn = wrapper.get('[data-testid="load-more-button"]');
    await loadMoreBtn.trigger('click');
    await nextTick();

    expect(wrapper.findAll('[data-testid^="binary-object-row-"]').length).toBe(120);
  });

  it('lazy loads thumbnails only when items become visible', async () => {
    vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['img'], { type: 'image/png' }));
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();

    // No thumbnails loaded initially
    expect(wrapper.find('[data-testid^="binary-thumbnail-"]').exists()).toBe(false);

    // itemObserver is the second one
    const itemObserver = observerInstances[1];
    const firstRowId = mockObjects[149]!.id; // Sorted desc, so 150 is first
    const firstRow = wrapper.get(`[data-testid="binary-object-row-${firstRowId}"]`);
    
    itemObserver?.trigger([{ isIntersecting: true, target: firstRow.element as HTMLElement }]);
    
    await flushPromises();
    vi.advanceTimersByTime(100); // Semaphore + Idle
    await flushPromises();

    expect(wrapper.find(`[data-testid="binary-thumbnail-${firstRowId}"]`).exists()).toBe(true);
  });

  it('cleans up thumbnails from memory when off-screen and limit exceeded', async () => {
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();

    const itemObserver = observerInstances[1];
    const vm = wrapper.vm as any;

    // Force high count
    vm.thumbnailCount = 301;
    vm.thumbnails['1'] = 'blob:mock-url-1';

    // Trigger off-screen for id "1"
    const target = document.createElement('div');
    target.setAttribute('data-id', '1');
    
    itemObserver?.trigger([{ isIntersecting: false, target: target as HTMLElement }]);
    
    // Cleanup is debounced by 3000ms in the new version
    vi.advanceTimersByTime(3500);
    
    // Should be deleted
    expect(vm.thumbnails['1']).toBeUndefined();
    expect(vm.thumbnailCount).toBe(300);
  });

  it('filters objects and resets display limit', async () => {
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();

    const input = wrapper.get('[data-testid="binary-search-input"]');
    await input.setValue('file10'); 
    
    // Matches file10, file100-109 -> 11 items
    expect(wrapper.get('[data-testid="binary-objects-count"]').text()).toContain('11 / 150');
    expect((wrapper.vm as any).displayLimit).toBe(60);
  });

  it('sorts objects by name', async () => {
    vi.mocked(storageService.listBinaryObjects).mockReturnValue(mockAsyncIterable([
      { id: '1', name: 'c.png', mimeType: 'image/png', size: 1024, createdAt: 1000 },
      { id: '2', name: 'a.png', mimeType: 'image/png', size: 1024, createdAt: 1001 },
      { id: '3', name: 'b.png', mimeType: 'image/png', size: 1024, createdAt: 1002 },
    ]) as any);
    
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();

    const nameHeader = wrapper.findAll('th').find(th => th.text().includes('Name'));
    await nameHeader?.trigger('click'); 
    
    let rows = wrapper.findAll('[data-testid^="binary-object-row-"]');
    expect(rows[0]!.text()).toContain('a.png');
    expect(rows[1]!.text()).toContain('b.png');
    expect(rows[2]!.text()).toContain('c.png');

    await nameHeader?.trigger('click'); // Toggle to desc
    rows = wrapper.findAll('[data-testid^="binary-object-row-"]');
    expect(rows[0]!.text()).toContain('c.png');
    expect(rows[1]!.text()).toContain('b.png');
    expect(rows[2]!.text()).toContain('a.png');
  });

  it('toggles between table and grid views', async () => {
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();

    expect(wrapper.find('table').exists()).toBe(true);
    
    const gridBtn = wrapper.get('[data-testid="view-mode-grid"]');
    await gridBtn.trigger('click');
    await nextTick();
    
    expect(wrapper.find('table').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid^="binary-object-grid-"]').length).toBe(60);
  });

  it('opens preview modal when a row is clicked', async () => {
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();

    // Default sort is createdAt desc, so id: 150 is first
    const row = wrapper.get('[data-testid="binary-object-row-150"]');
    await row.trigger('click');
    
    expect(mockOpenPreview).toHaveBeenCalledWith({
      objects: expect.any(Array),
      initialId: '150'
    });
  });

  it('handles file download', async () => {
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();

    const downloadBtn = wrapper.get('[data-testid="download-button-150"]');
    await downloadBtn?.trigger('click');
    
    expect(mockDownloadBinaryObject).toHaveBeenCalledWith(expect.objectContaining({ id: '150' }));
  });

  it('deletes an object after confirmation', async () => {
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();

    mockDeleteBinaryObject.mockResolvedValue(true);

    const deleteBtn = wrapper.get('[data-testid="delete-button-150"]');
    await deleteBtn?.trigger('click');
    
    await flushPromises();
    
    expect(mockDeleteBinaryObject).toHaveBeenCalledWith('150');
    expect(wrapper.text()).not.toContain('file150.png');
  });

  it('cancels deletion if not confirmed', async () => {
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();

    mockDeleteBinaryObject.mockResolvedValue(false);

    const deleteBtn = wrapper.get('[data-testid="delete-button-150"]');
    await deleteBtn.trigger('click');
    
    await flushPromises();
    
    expect(wrapper.text()).toContain('file150.png');
  });

  it('generates thumbnails for images', async () => {
    vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['img'], { type: 'image/png' }));
    
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();
    
    const itemObserver = observerInstances[1];
    const firstRow = wrapper.get('[data-testid="binary-object-row-150"]');
    itemObserver?.trigger([{ isIntersecting: true, target: firstRow.element as HTMLElement }]);

    await flushPromises();
    vi.advanceTimersByTime(200);
    await flushPromises();

    expect(wrapper.get('[data-testid="binary-thumbnail-150"]').attributes('src')).toContain('blob:mock-url');
  });
});
