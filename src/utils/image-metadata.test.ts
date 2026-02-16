import { describe, it, expect } from 'vitest';
import { detectFormat, embedMetadataInPng, embedMetadataInWebp, UNSUPPORTED } from './image-metadata';

/**
 * Helper to read a Blob as ArrayBuffer in environments like jsdom where
 * blob.arrayBuffer() is not available.
 */
async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Minimum valid PNG bytes (8-byte signature + 13-byte IHDR chunk)
 */
const MIN_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG Signature
  0x00, 0x00, 0x00, 0x0d, // IHDR Length (13)
  0x49, 0x48, 0x44, 0x52, // IHDR Type
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // Width/Height (1x1)
  0x08, 0x02, 0x00, 0x00, 0x00, // 8-bit RGB
  0x90, 0x77, 0x53, 0xde // IHDR CRC
]);

/**
 * Minimum WebP bytes (RIFF structure)
 */
const MIN_WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, // RIFF
  0x0c, 0x00, 0x00, 0x00, // Chunk Size
  0x57, 0x45, 0x42, 0x50, // WEBP Signature
]);

describe('image-metadata utilities', () => {
  describe('detectFormat', () => {
    it('detects PNG format', async () => {
      const blob = new Blob([MIN_PNG], { type: 'image/png' });
      const format = await detectFormat({ blob });
      expect(format).toBe('png');
    });

    it('detects WebP format', async () => {
      const blob = new Blob([MIN_WEBP], { type: 'image/webp' });
      const format = await detectFormat({ blob });
      expect(format).toBe('webp');
    });

    it('returns UNSUPPORTED for other types', async () => {
      const blob = new Blob(['not an image'], { type: 'text/plain' });
      const format = await detectFormat({ blob });
      expect(format).toBe(UNSUPPORTED);
    });
  });

  describe('embedMetadataInPng', () => {
    it('embeds prompt, model, steps and seed into a PNG blob', async () => {
      const blob = new Blob([MIN_PNG], { type: 'image/png' });
      const metadata = {
        prompt: 'A beautiful mountain landscape',
        model: 'naidan-v1-alpha',
        steps: 25,
        seed: 12345
      };

      const result = await embedMetadataInPng({ blob, metadata });
      const buffer = await blobToArrayBuffer(result);
      const bytes = new Uint8Array(buffer);
      const text = new TextDecoder().decode(bytes);

      expect(result.type).toBe('image/png');
      expect(result.size).toBeGreaterThan(blob.size);
      expect(text).toContain('prompt');
      expect(text).toContain(metadata.prompt);
      expect(text).toContain('model');
      expect(text).toContain(metadata.model);
      expect(text).toContain('steps');
      expect(text).toContain('25');
      expect(text).toContain('seed');
      expect(text).toContain('12345');
    });
  });

  describe('embedMetadataInWebp', () => {
    it('embeds prompt, model, steps and seed into a WebP blob', async () => {
      const blob = new Blob([MIN_WEBP], { type: 'image/webp' });
      const metadata = {
        prompt: 'Cyberpunk city, neon lighting',
        model: 'flux-1-schnell',
        steps: 30,
        seed: 67890
      };

      const result = await embedMetadataInWebp({ blob, metadata });
      const buffer = await blobToArrayBuffer(result);
      const text = new TextDecoder().decode(buffer);

      expect(result.type).toBe('image/webp');
      expect(result.size).toBeGreaterThan(blob.size);
      expect(text).toContain('xmpmeta');
      expect(text).toContain('dc:description');
      expect(text).toContain(metadata.prompt);
      expect(text).toContain('CreatorTool');
      expect(text).toContain(metadata.model);
      expect(text).toContain('naidan:steps');
      expect(text).toContain('30');
      expect(text).toContain('naidan:seed');
      expect(text).toContain('67890');
    });
  });
});
