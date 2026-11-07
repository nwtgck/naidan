import { describe, expect, it } from 'vitest';
import { appUrlFromLocation } from './app-location';

describe('application URL identity', () => {
  it.each(['https://naidan.pages.dev', 'https://naidan.nwtgck.org', 'http://localhost:5173'])('keeps the actual origin at %s', origin => {
    const href = `${origin}/llama-cpp-browser/hf.co/LiquidAI/LFM2.5-230M-GGUF/?source=x&quant=Q4_K_M`;
    const result = appUrlFromLocation({ href });
    expect(result.href).toBe(`${origin}/?source=x`);
  });

  it('uses the app root for unlisted repositories as well', () => {
    expect(appUrlFromLocation({ href: 'https://example.test/llama-cpp-browser/hf.co/owner/Unknown?quant=Q8_0' }).pathname).toBe('/');
  });

  it('keeps a hosted mount when generating app or share URLs from a model page', () => {
    const result = appUrlFromLocation({ href: 'https://example.test/nested/app/llama-cpp-browser/hf.co/owner/Model?source=docs&quant=Q4_K_M' });
    expect(result.href).toBe('https://example.test/nested/app/?source=docs');
  });

  it.each([
    'file:///home/user/Naidan/index.html#/',
    'https://example.test/nested/app/index.html#/',
    'https://example.test/nested/app/#/',
  ])('does not rewrite portable paths: %s', href => {
    expect(appUrlFromLocation({ href }).href).toBe(href);
  });
});
