import { describe, expect, it } from 'vitest';
import { appUrlFromLocation } from './app-location';

describe('application URL identity', () => {
  it.each(['https://naidan.pages.dev', 'https://naidan.nwtgck.org', 'http://localhost:5173'])('keeps the actual origin at %s', origin => {
    const href = `${origin}/llama-cpp-browser/hf.co/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M/?source=x`;
    const result = appUrlFromLocation({ href });
    expect(result.href).toBe(`${origin}/?source=x`);
  });

  it.each([
    'file:///home/user/Naidan/index.html#/',
    'https://example.test/nested/app/index.html#/',
    'https://example.test/nested/app/#/',
    'https://example.test/llama-cpp-browser/hf.co/owner/Unknown:Q4_K_M/',
  ])('does not rewrite portable or unknown paths: %s', href => {
    expect(appUrlFromLocation({ href }).href).toBe(href);
  });
});
