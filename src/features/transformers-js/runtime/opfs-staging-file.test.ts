import { describe, expect, it, vi } from 'vitest';
import { createOpfsStagingFileName, isOpfsStagingFileName } from './opfs-staging-file';

describe('writer staging basename contract', () => {
  it('recognizes the exact name produced by the shared explicit writer helper', () => {
    const random = vi.spyOn(crypto, 'randomUUID').mockReturnValue('f28f6802-947c-4b9d-bc99-223d8d469f4b');
    try {
      const fileName = createOpfsStagingFileName({ fileName: 'vision_encoder_q4.onnx_data' });
      expect(fileName).toBe('.vision_encoder_q4.onnx_data.staging-f28f6802-947c-4b9d-bc99-223d8d469f4b');
      expect(isOpfsStagingFileName({ fileName })).toBe(true);
    } finally {
      random.mockRestore();
    }
  });
  it.each(['vision_encoder.onnx', '.vision_encoder.onnx.complete', '.hidden', '.vision.onnx.staging-id',
    '.vision.onnx.staging-f28f6802-947c-1b9d-bc99-223d8d469f4b', '.vision.onnx.staging-f28f6802-947c-4b9d-7c99-223d8d469f4b',
    'prefix/.vision.onnx.staging-f28f6802-947c-4b9d-bc99-223d8d469f4b', '.vision.onnx.staging-f28f6802-947c-4b9d-bc99-223d8d469f4b.partial'])('does not hide another filename %s', fileName => {
    expect(isOpfsStagingFileName({ fileName })).toBe(false);
  });
});
