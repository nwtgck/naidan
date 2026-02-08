import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from './string';

describe('sanitizeFilename', () => {
  it('removes invalid characters and normalizes whitespace', () => {
    const result = sanitizeFilename({
      base: '  hello / \\ ? % * : | " < > world  ',
      suffix: '.png',
      fallback: 'fallback'
    });
    // Each of the 10 invalid characters becomes a dash.
    // Spaces are normalized.
    expect(result).toBe('hello - - - - - - - - - - world.png');
  });

  it('uses fallback if base becomes empty or just dashes after sanitization', () => {
    const result = sanitizeFilename({
      base: '/\\?%*:|"<>',
      suffix: '.txt',
      fallback: 'default-name'
    });
    expect(result).toBe('default-name.txt');
  });

  it('truncates to 255 bytes including suffix and ellipsis', () => {
    const longBase = 'a'.repeat(250);
    const result = sanitizeFilename({
      base: longBase,
      suffix: '.png',
      fallback: 'fallback'
    });
    expect(result).toBe(longBase + '.png');
    expect(new TextEncoder().encode(result).length).toBe(254);

    const veryLongBase = 'b'.repeat(300);
    const resultTruncated = sanitizeFilename({
      base: veryLongBase,
      suffix: '.png',
      fallback: 'fallback'
    });
    // MAX_BYTES(255) - suffix(4) - ellipsis(3) = 248 chars of 'b'
    expect(resultTruncated).toBe('b'.repeat(248) + '....png');
    expect(new TextEncoder().encode(resultTruncated).length).toBe(255);
  });

  it('handles multi-byte UTF-8 characters during truncation', () => {
    const emojiBase = '🐱'.repeat(100); // 🐱 is 4 bytes
    const result = sanitizeFilename({
      base: emojiBase,
      suffix: '.png',
      fallback: 'fallback'
    });
    
    const byteLength = new TextEncoder().encode(result).length;
    expect(byteLength).toBeLessThanOrEqual(255);
    expect(result.endsWith('....png')).toBe(true);
  });

  it('safely truncates at surrogate pair boundaries', () => {
    // 𩸽 (U+29E3D) is 4 bytes in UTF-8.
    const suffix = '.png'; // 4 bytes
    // Max for base = 255 - 4 (suffix) - 3 (ellipsis) = 248 bytes.
    
    // Create a base that is 248 bytes (exactly the limit for base when ellipsis is needed), 
    // then add a 4-byte char. Total = 248 + 4 + 4 = 256 bytes (> 255).
    const base = 'a'.repeat(248) + '𩸽';
    
    const result = sanitizeFilename({
      base,
      suffix,
      fallback: 'fb'
    });
    
    expect(result).toBe('a'.repeat(248) + '....png');
    expect(new TextEncoder().encode(result).length).toBe(248 + 3 + 4);
  });

  it('handles extremely long suffixes by truncating total length', () => {
    const result = sanitizeFilename({
      base: 'test',
      suffix: '.' + 's'.repeat(300),
      fallback: 'fallback'
    });
    const byteLength = new TextEncoder().encode(result).length;
    expect(byteLength).toBe(255);
  });
});
