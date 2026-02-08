import { describe, it, expect, vi } from 'vitest';
import { reencodeImage } from './image-processing';

// Mock createImageBitmap and Canvas methods since we are in a test environment
const mockDrawImage = vi.fn();
const mockToBlob = vi.fn();

// Setup global mocks for the environment
global.createImageBitmap = vi.fn().mockResolvedValue({
  width: 100,
  height: 100,
  close: vi.fn(),
});

HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
  drawImage: mockDrawImage,
}) as any;

HTMLCanvasElement.prototype.toBlob = function(
  callback: (blob: Blob | null) => void, 
  mimeType?: string, 
  quality?: any
) {
  mockToBlob(mimeType, quality);
  callback(new Blob(['converted'], { type: mimeType }));
} as any;

describe('image-processing utility', () => {
  it('re-encodes an image to the specified format with high quality', async () => {
    const inputBlob = new Blob(['original'], { type: 'image/png' });
    const outputFormat = 'webp';
    
    const result = await reencodeImage({ blob: inputBlob, format: outputFormat });
    
    expect(result.type).toBe('image/webp');
    expect(mockToBlob).toHaveBeenCalledWith('image/webp', 1.0);
    expect(mockDrawImage).toHaveBeenCalled();
  });

  it('handles JPEG format correctly', async () => {
    const inputBlob = new Blob(['original'], { type: 'image/png' });
    const result = await reencodeImage({ blob: inputBlob, format: 'jpeg' });
    
    expect(result.type).toBe('image/jpeg');
    expect(mockToBlob).toHaveBeenCalledWith('image/jpeg', 1.0);
  });

  it('handles PNG format correctly (re-encoding even if same)', async () => {
    const inputBlob = new Blob(['original'], { type: 'image/png' });
    const result = await reencodeImage({ blob: inputBlob, format: 'png' });
    
    expect(result.type).toBe('image/png');
    expect(mockToBlob).toHaveBeenCalledWith('image/png', 1.0);
  });
});
