import { describe, expect, it } from 'vitest';
import { jsonToHighlightedHtml, sanitizeHighlightHtml, sanitizeMarkdownHtml } from './allowedHtml';

describe('AllowedHtml security helpers', () => {
  it('adds safe new-tab attributes to external Markdown links', () => {
    const html = sanitizeMarkdownHtml({
      html: '<a href="https://external.example/path">External</a>',
    });
    const container = document.createElement('div');
    container.innerHTML = String(html);
    const link = container.querySelector('a');

    expect(link?.getAttribute('href')).toBe('https://external.example/path');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(link?.getAttribute('data-naidan-external-link')).toBe('true');
  });

  it('removes caller-provided navigation attributes from same-origin Markdown links', () => {
    const sameOriginHref = new URL('/settings', window.location.href).href;
    const html = sanitizeMarkdownHtml({
      html: `<a href="${sameOriginHref}" target="_blank" rel="opener" referrerpolicy="unsafe-url" data-naidan-external-link="true">Internal</a>`,
    });
    const container = document.createElement('div');
    container.innerHTML = String(html);
    const link = container.querySelector('a');

    expect(link?.getAttribute('href')).toBe(sameOriginHref);
    expect(link?.getAttribute('target')).toBeNull();
    expect(link?.getAttribute('rel')).toBeNull();
    expect(link?.getAttribute('referrerpolicy')).toBeNull();
    expect(link?.getAttribute('data-naidan-external-link')).toBeNull();
  });

  it('does not treat relative or non-http Markdown links as external websites', () => {
    const html = sanitizeMarkdownHtml({
      html: '<a href="/settings">Internal</a><a href="mailto:user@example.com">Mail</a>',
    });
    const container = document.createElement('div');
    container.innerHTML = String(html);
    const links = container.querySelectorAll('a');

    for (const link of links) {
      expect(link.getAttribute('target')).toBeNull();
      expect(link.getAttribute('rel')).toBeNull();
      expect(link.getAttribute('referrerpolicy')).toBeNull();
      expect(link.getAttribute('data-naidan-external-link')).toBeNull();
    }
  });

  it('still strips unsafe Markdown link protocols', () => {
    const html = sanitizeMarkdownHtml({
      html: '<a href="javascript:alert(1)" target="_blank">Unsafe</a>',
    });
    const container = document.createElement('div');
    container.innerHTML = String(html);
    const link = container.querySelector('a');

    expect(link?.getAttribute('href')).toBeNull();
    expect(link?.getAttribute('target')).toBeNull();
    expect(link?.getAttribute('data-naidan-external-link')).toBeNull();
  });

  it('keeps highlight.js span classes and strips non-class attributes', () => {
    const html = sanitizeHighlightHtml({
      html: '<span class="hljs-keyword" data-x="1" aria-label="x" style="color:red">const</span><br><em>x</em><script>alert(1)</script>',
    });

    expect(String(html)).toBe('<span class="hljs-keyword">const</span>x');
  });

  it('preserves the raw JSON key style used by ChatDebugInspector', () => {
    const html = jsonToHighlightedHtml({
      json: JSON.stringify({ key: 'value' }, null, 2),
      highlight: true,
      keyStyle: 'raw',
    });

    expect(String(html)).toContain('<span class="text-red-500 dark:text-red-400 font-bold">"key":</span>');
    expect(String(html)).not.toContain('opacity-80 font-bold');
  });

  it('preserves the tree JSON key style used by ChatDebugTreeNode', () => {
    const html = jsonToHighlightedHtml({
      json: JSON.stringify({ key: 'value' }, null, 2),
      highlight: true,
      keyStyle: 'tree',
    });

    expect(String(html)).toContain('<span class="text-red-500 dark:text-red-400 opacity-80">"key":</span>');
    expect(String(html)).not.toContain('opacity-80 font-bold');
  });
});
