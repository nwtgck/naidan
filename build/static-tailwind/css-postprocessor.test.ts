import { describe, expect, it } from 'vitest';
import {
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
});
