import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  createTailwindCssRegistrationModuleSource,
  createTailwindCssRegistry,
} from './tailwind-css-runtime-source.mjs';

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
  return { callbacks, dom, registry, flushScheduled };
}

describe('static Tailwind runtime CSS registry', () => {
  it('loads required CSS registration dependencies before registering a fragment group', () => {
    const source = createTailwindCssRegistrationModuleSource({
      moduleId: '\0virtual:naidan-tailwind-css-module/lazy.js',
      fragments: [[1, '.lazy {}']],
      runtimeModuleId: 'virtual:naidan-tailwind-css-runtime',
      dependencyModuleIds: ['virtual:naidan-tailwind-css-module/initial.js'],
    });

    expect(source.indexOf('import "virtual:naidan-tailwind-css-module/initial.js";')).toBeLessThan(
      source.indexOf('registerTailwindCssModule'),
    );
  });

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

  it('does not schedule a rewrite when a module re-registers identical fragments', () => {
    const { callbacks, registry, flushScheduled } = createFixture();
    registry.register({ moduleId: 'a', fragments: [[1, '.a {}']] });
    flushScheduled();
    registry.register({ moduleId: 'a', fragments: [[1, '.a {}']] });
    expect(callbacks).toHaveLength(0);
  });

  it('prefers the latest registration during an HMR ownership overlap', () => {
    const { dom, registry, flushScheduled } = createFixture();
    registry.register({ moduleId: 'old-owner', fragments: [[1, '.value { color: red; }']] });
    flushScheduled();
    registry.register({ moduleId: 'new-owner', fragments: [[1, '.value { color: blue; }']] });
    flushScheduled();

    const css = dom.window.document.querySelector('style[data-naidan-tailwind-runtime]')?.textContent ?? '';
    expect(css).not.toContain('color: red');
    expect(css).toContain('color: blue');

    registry.unregister({ moduleId: 'old-owner' });
    flushScheduled();
    expect(dom.window.document.querySelector('style[data-naidan-tailwind-runtime]')?.textContent).toContain('color: blue');
  });

  it('treats an identical re-registration as latest during an HMR ownership overlap', () => {
    const { callbacks, dom, registry, flushScheduled } = createFixture();
    registry.register({ moduleId: 'retained-owner', fragments: [[1, '.value { color: red; }']] });
    flushScheduled();
    registry.register({ moduleId: 'retiring-owner', fragments: [[1, '.value { color: blue; }']] });
    flushScheduled();

    registry.register({ moduleId: 'retained-owner', fragments: [[1, '.value { color: red; }']] });
    expect(callbacks).toHaveLength(1);
    flushScheduled();

    const css = dom.window.document.querySelector('style[data-naidan-tailwind-runtime]')?.textContent ?? '';
    expect(css).toContain('color: red');
    expect(css).not.toContain('color: blue');
  });

  it('adopts and repositions an existing runtime style before component styles', () => {
    const dom = new JSDOM(`<!doctype html><html><head>
      <style data-component-style>.component { color: red; }</style>
      <style data-naidan-tailwind-runtime>.stale { color: black; }</style>
      <style data-naidan-tailwind-runtime>.duplicate { color: orange; }</style>
    </head><body></body></html>`);
    const callbacks: (() => void)[] = [];
    const registry = createTailwindCssRegistry({
      document: dom.window.document,
      scheduleFlush({ callback }) {
        callbacks.push(callback);
      },
    });

    registry.register({ moduleId: 'a', fragments: [[1, '.a { display: block; }']] });
    callbacks.shift()?.();

    const runtimeStyle = dom.window.document.querySelector('style[data-naidan-tailwind-runtime]');
    expect(dom.window.document.head.firstElementChild).toBe(runtimeStyle);
    expect(runtimeStyle?.textContent).toBe('.a { display: block; }');
    expect(dom.window.document.querySelectorAll('style[data-naidan-tailwind-runtime]')).toHaveLength(1);
  });

  it('recreates a removed runtime style element from the complete registered fragment set', () => {
    const { dom, registry, flushScheduled } = createFixture();
    registry.register({ moduleId: 'a', fragments: [[1, '.a {}']] });
    flushScheduled();
    dom.window.document.querySelector('style[data-naidan-tailwind-runtime]')?.remove();

    registry.register({ moduleId: 'b', fragments: [[2, '.b {}']] });
    flushScheduled();

    const styles = dom.window.document.querySelectorAll('style[data-naidan-tailwind-runtime]');
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toContain('.a {}');
    expect(styles[0]?.textContent).toContain('.b {}');
    expect(dom.window.document.head.firstElementChild).toBe(styles[0]);
  });

  it('rejects malformed or duplicate fragment orders within one module', () => {
    const { registry } = createFixture();
    expect(() => registry.register({
      moduleId: 'duplicate',
      fragments: [[1, '.a {}'], [1, '.b {}']],
    })).toThrow(/Duplicate static Tailwind CSS fragment order 1/u);
    expect(() => registry.register({
      moduleId: 'invalid',
      fragments: [[-1, '.a {}']],
    })).toThrow(/Invalid static Tailwind CSS fragment/u);
  });
});
