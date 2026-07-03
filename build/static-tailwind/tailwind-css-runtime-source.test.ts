import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { createTailwindCssRegistry } from './tailwind-css-runtime-source.mjs';

function createFixture() {
  const dom = new JSDOM('<!doctype html><html><head><style data-component-style>.component { color: red; }</style></head><body></body></html>');
  const callbacks: (() => void)[] = [];
  const registry = createTailwindCssRegistry({
    document: dom.window.document,
    scheduleFlush({ callback }) {
      callbacks.push(callback);
    },
  });
  function flushScheduled() {
    while (callbacks.length > 0) callbacks.shift()?.();
  }
  return { dom, registry, flushScheduled };
}

describe('static Tailwind runtime CSS registry', () => {
  it('reconstructs canonical CSS order independently of module registration order', () => {
    const { dom, registry, flushScheduled } = createFixture();
    registry.register({
      moduleId: 'late',
      fragments: [[20, '@layer utilities { .p-4 { padding: 1rem; } }']],
    });
    registry.register({
      moduleId: 'early',
      fragments: [[10, '@layer utilities { .p-2 { padding: .5rem; } }']],
    });
    flushScheduled();

    const style = dom.window.document.querySelector('style[data-naidan-tailwind-runtime]');
    expect(style).not.toBeNull();
    expect(style?.textContent?.indexOf('.p-2')).toBeLessThan(style?.textContent?.indexOf('.p-4') ?? -1);
    expect(dom.window.document.head.firstElementChild).toBe(style);
  });

  it('batches registrations into one scheduled rewrite', () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
    const callbacks: (() => void)[] = [];
    const registry = createTailwindCssRegistry({
      document: dom.window.document,
      scheduleFlush({ callback }) {
        callbacks.push(callback);
      },
    });
    registry.register({ moduleId: 'a', fragments: [[1, '.a {}']] });
    registry.register({ moduleId: 'b', fragments: [[2, '.b {}']] });
    expect(callbacks).toHaveLength(1);
    callbacks.shift()?.();
    expect(dom.window.document.querySelectorAll('style[data-naidan-tailwind-runtime]')).toHaveLength(1);
  });

  it('removes retired module fragments while retaining the remaining canonical order', () => {
    const { dom, registry, flushScheduled } = createFixture();
    registry.register({ moduleId: 'a', fragments: [[1, '.a {}'], [3, '.c {}']] });
    registry.register({ moduleId: 'b', fragments: [[2, '.b {}']] });
    flushScheduled();
    registry.unregister({ moduleId: 'b' });
    flushScheduled();

    const css = dom.window.document.querySelector('style[data-naidan-tailwind-runtime]')?.textContent ?? '';
    expect(css).toContain('.a {}');
    expect(css).not.toContain('.b {}');
    expect(css).toContain('.c {}');
  });
});
