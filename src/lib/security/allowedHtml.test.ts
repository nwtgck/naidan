import { describe, expect, it } from 'vitest';
import { jsonToHighlightedHtml, sanitizeHighlightHtml } from './allowedHtml';

describe('AllowedHtml security helpers', () => {
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
