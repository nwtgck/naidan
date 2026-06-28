import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useBinaryActions } from './useBinaryActions';
import { storageService } from '@/services/storage';
import { toBinaryObjectId } from '@/models/ids';

vi.mock('../services/storage', () => ({
  storageService: {
    getBinaryObject: vi.fn(),
    getFile: vi.fn(),
    deleteBinaryObject: vi.fn(),
  },
}));

const mockShowConfirm = vi.fn();
vi.mock('./useConfirm', () => ({
  useConfirm: vi.fn(() => ({
    showConfirm: mockShowConfirm,
  })),
}));

const mockClosePreview = vi.fn();
vi.mock('./useImagePreview', () => ({
  useImagePreview: vi.fn(() => ({
    closePreview: mockClosePreview,
    state: { value: null },
  })),
}));

describe('useBinaryActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:url') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

  it('deletes object after confirmation', async () => {
    const { deleteBinaryObject } = useBinaryActions();
    vi.mocked(storageService.getBinaryObject).mockResolvedValue({
      id: toBinaryObjectId({ raw: 'bin-1' }), name: 'test.png', mimeType: 'image/png', size: 100, createdAt: 1000,
    });
    mockShowConfirm.mockResolvedValue(true);

    const result = await deleteBinaryObject({ id: toBinaryObjectId({ raw: 'bin-1' }) });

    expect(result).toBe(true);
    expect(storageService.deleteBinaryObject).toHaveBeenCalledWith({ binaryObjectId: toBinaryObjectId({ raw: 'bin-1' }) });
    expect(mockClosePreview).toHaveBeenCalled();
  });

  it('cancels deletion if not confirmed', async () => {
    const { deleteBinaryObject } = useBinaryActions();
    vi.mocked(storageService.getBinaryObject).mockResolvedValue({ id: toBinaryObjectId({ raw: 'bin-1' }) } as any);
    mockShowConfirm.mockResolvedValue(false);

    const result = await deleteBinaryObject({ id: toBinaryObjectId({ raw: 'bin-1' }) });

    expect(result).toBe(false);
    expect(storageService.deleteBinaryObject).not.toHaveBeenCalled();
  });

  it('downloads object', async () => {
    const { downloadBinaryObject } = useBinaryActions();
    const mockBlob = new Blob(['data']);
    vi.mocked(storageService.getFile).mockResolvedValue(mockBlob);

    // Mock document.createElement
    const mockAnchor = {
      click: vi.fn(),
      href: '',
      download: '',
    };
    const spy = vi.spyOn(document, 'createElement').mockReturnValue(mockAnchor as any);
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => mockAnchor as any);
    vi.spyOn(document.body, 'removeChild').mockImplementation(() => mockAnchor as any);

    await downloadBinaryObject({ obj: { id: toBinaryObjectId({ raw: 'bin-1' }), name: 'test.png' } });

    expect(storageService.getFile).toHaveBeenCalledWith({ binaryObjectId: toBinaryObjectId({ raw: 'bin-1' }) });
    expect(URL.createObjectURL).toHaveBeenCalledWith(mockBlob);
    expect(mockAnchor.download).toBe('test.png');
    expect(mockAnchor.click).toHaveBeenCalled();

    spy.mockRestore();
  });
});
