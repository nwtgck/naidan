import { describe, expect, it } from 'vitest';
import {
  assertStaticTailwindCssHasNoRelativeUrls,
  naidanAutoprefixerOptions,
  postprocessStaticTailwindCss,
} from './css-postprocessor.mjs';

describe('static Tailwind CSS postprocessor', () => {
  it('adds the same browser compatibility declarations used by ordinary CSS assets', () => {
    const css = postprocessStaticTailwindCss({
      css: '.fixture { appearance: none; user-select: none; }',
    });

    expect(css).toContain('-webkit-appearance: none');
    expect(css).toContain('-webkit-user-select: none');
    expect(css).toContain('-moz-user-select: none');
    expect(css).toContain('user-select: none');
    expect(naidanAutoprefixerOptions).toEqual({});
  });

  it('is idempotent when Vite processes single-mode CSS a second time', () => {
    const once = postprocessStaticTailwindCss({
      css: '.fixture { appearance: none; user-select: none; }',
    });
    const twice = postprocessStaticTailwindCss({ css: once });

    expect(twice).toBe(once);
  });

  it('accepts URL forms whose meaning is independent of the runtime style location', () => {
    expect(() => assertStaticTailwindCssHasNoRelativeUrls({
      css: `\
.fixture {
  background-image:
    url("data:image/svg+xml,%3Csvg/%3E"),
    url("https://example.com/asset.svg"),
    url("//cdn.example.com/asset.svg"),
    url("/assets/asset.svg"),
    url("#local-fragment");
}
`,
    })).not.toThrow();
  });

  it.each([
    './asset.svg',
    '../asset.svg',
    'asset.svg',
  ])('rejects relative runtime CSS asset URL %s', (url) => {
    expect(() => assertStaticTailwindCssHasNoRelativeUrls({
      css: `.fixture { background-image: url(${JSON.stringify(url)}); }`,
    })).toThrow(/Split runtime CSS cannot preserve relative asset URLs/u);
  });
});
