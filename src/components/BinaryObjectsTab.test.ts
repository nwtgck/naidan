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

// Spy on document.createElement instead of stubbing entire document
const originalCreateElement = document.createElement.bind(document);
const mockCanvas = {
  getContext: vi.fn(() => ({
    drawImage: vi.fn(),
  })),
  toDataURL: vi.fn(() => 'data:image/jpeg;base64,mock'),
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

const mockObjects: BinaryObject[] = [
  { id: '1', name: 'image1.png', mimeType: 'image/png', size: 1024, createdAt: 1000 },
  { id: '2', name: 'document.pdf', mimeType: 'application/pdf', size: 2048, createdAt: 2000 },
  { id: '3', name: 'photo.jpg', mimeType: 'image/jpeg', size: 512, createdAt: 500 },
];

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
    vi.mocked(storageService.listBinaryObjects).mockReturnValue(mockAsyncIterable(mockObjects) as any);
  });

  it('renders correctly and fetches objects on mount', async () => {
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    
    // Initially shows loading
    expect(wrapper.text()).toContain('Loading objects...');
    
    await flushPromises();
    
    // Should show table by default
    expect(wrapper.find('table').exists()).toBe(true);
    expect(wrapper.text()).toContain('image1.png');
    expect(wrapper.text()).toContain('document.pdf');
    expect(wrapper.text()).toContain('photo.jpg');
  });

  it('filters objects based on search query', async () => {
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();

    const input = wrapper.find('input[placeholder="Search by name, ID, or type..."]');
    await input.setValue('image1');
    
    expect(wrapper.text()).toContain('image1.png');
    expect(wrapper.text()).not.toContain('document.pdf');
    expect(wrapper.text()).not.toContain('photo.jpg');
  });

  it('sorts objects by name', async () => {
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();

    const nameHeader = wrapper.findAll('th').find(th => th.text().includes('Name'));
    await nameHeader?.trigger('click'); 
    
    let rows = wrapper.findAll('tbody tr');
    // Default was desc, clicked Name -> sort Order becomes asc
    // ASC Name: document.pdf, image1.png, photo.jpg
    expect(rows[0]!.text()).toContain('document.pdf');
    expect(rows[1]!.text()).toContain('image1.png');
    expect(rows[2]!.text()).toContain('photo.jpg');

    await nameHeader?.trigger('click'); // Toggle to desc
    rows = wrapper.findAll('tbody tr');
    expect(rows[0]!.text()).toContain('photo.jpg');
    expect(rows[1]!.text()).toContain('image1.png');
    expect(rows[2]!.text()).toContain('document.pdf');
  });

  it('toggles between table and grid views', async () => {
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();

    // Default is table
    expect(wrapper.find('table').exists()).toBe(true);
    expect((wrapper.vm as any).viewMode).toBe('table');
    
    // Find the grid button (it has @click="viewMode = 'grid'")
    // We can try to find by the icon or just set it directly if trigger is being flaky, 
    // but trigger should work.
    const buttons = wrapper.findAll('button');
    const gridBtn = buttons.find(b => b.html().includes('layout-grid'));
    await gridBtn?.trigger('click');
    await nextTick();
    
    expect((wrapper.vm as any).viewMode).toBe('grid');
    expect(wrapper.find('table').exists()).toBe(false);
    expect(wrapper.find('.grid').exists()).toBe(true);
  });

  it('opens preview modal when a row is clicked', async () => {
    document.body.innerHTML = '';
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();

    vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['mock data'], { type: 'image/png' }));

    const row = wrapper.find('tbody tr');
    await row.trigger('click');
    
    await flushPromises();
    await nextTick();
    
    const bodyText = document.body.textContent;
    expect(bodyText).toContain('Preview');
    expect(bodyText).toContain('document.pdf');
  });

  it('handles file download', async () => {
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();

    const mockBlob = new Blob(['data'], { type: 'application/pdf' });
    vi.mocked(storageService.getFile).mockResolvedValue(mockBlob);

    const row = wrapper.findAll('tbody tr').find(r => r.text().includes('document.pdf'));
    const downloadBtn = row?.find('button[title="Download"]');
    await downloadBtn?.trigger('click');
    
    await flushPromises();
    
    expect(storageService.getFile).toHaveBeenCalledWith('2');
    expect(URL.createObjectURL).toHaveBeenCalledWith(mockBlob);
  });

  it('deletes an object after confirmation', async () => {
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();

    mockShowConfirm.mockResolvedValue(true);
    vi.mocked(storageService.deleteBinaryObject).mockResolvedValue(undefined);

    const row = wrapper.findAll('tbody tr').find(r => r.text().includes('image1.png'));
    const deleteBtn = row?.find('button[title="Delete"]');
    await deleteBtn?.trigger('click');
    
    expect(mockShowConfirm).toHaveBeenCalled();
    await flushPromises();
    
    expect(storageService.deleteBinaryObject).toHaveBeenCalledWith('1');
    expect(wrapper.text()).not.toContain('image1.png');
  });

  it('cancels deletion if not confirmed', async () => {
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();

    mockShowConfirm.mockResolvedValue(false);

    const row = wrapper.findAll('tbody tr').find(r => r.text().includes('image1.png'));
    const deleteBtn = row?.find('button[title="Delete"]');
    await deleteBtn?.trigger('click');
    
    await flushPromises();
    
    expect(storageService.deleteBinaryObject).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('image1.png');
  });

  it('generates thumbnails for images', async () => {
    vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['img'], { type: 'image/png' }));
    
    const wrapper = mount(BinaryObjectsTab, { global: { stubs: globalStubs } });
    await flushPromises();
    
    await nextTick();
    await new Promise(r => setTimeout(r, 150)); // Wait for image load mock and semaphore
    await flushPromises();

    const img = wrapper.find('img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toContain('data:image/jpeg;base64,mock');
  });
});
