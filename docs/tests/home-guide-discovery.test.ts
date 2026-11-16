import { readFileSync } from 'node:fs';
import { compileStyle, parse as parseSfc } from '@vue/compiler-sfc';
import { parse as parseCss } from 'postcss';
import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import HomePage from '../pages/index/index.vue';
import { messages as homeEn } from '../pages/index/messages/en';
import { messages as homeJa } from '../pages/index/messages/ja';
import { messages as commonEn } from '../messages/common/en';
import { messages as commonJa } from '../messages/common/ja';
import { docsHref } from '../navigation/routes';
import { parsePage } from './site.test-support';

const discoveryPages = [
  'translation',
  'live-conversation',
  'workflow',
  'image-generation-multi-prompt',
  'image-understanding',
  'chat-search',
  'chat-group',
  'tool-wikipedia',
  'pwa',
] as const;

describe('homepage guide discovery', () => {
  it.each([
    { locale: 'en', messages: homeEn, common: commonEn },
    { locale: 'ja', messages: homeJa, common: commonJa },
  ] as const)('offers complete, static $locale routes into the six tasks alongside the existing guides', async ({ locale, messages, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(HomePage, { s: messages, locale, common }) }));
    using page = parsePage({ html });
    const section = page.document.querySelector('[data-testid="docs-guides"]');
    const cards = Array.from(section?.querySelectorAll<HTMLAnchorElement>('[data-testid="docs-home-guide-card"]') ?? []);
    expect(cards.map(card => card.getAttribute('href'))).toEqual(discoveryPages.map(article => docsHref({ locale, page: article })));
    expect(section?.getAttribute('aria-labelledby')).toBe(section?.querySelector('h2')?.id);
    expect(section?.querySelectorAll('ul > li')).toHaveLength(discoveryPages.length);
    expect(section?.querySelector('script, [data-docs-island], button, input, select')).toBeNull();
    for (const card of cards) {
      expect(card.querySelector('h3')?.textContent?.trim()).toBeTruthy();
      expect(card.querySelector('p')?.textContent?.trim()).toBeTruthy();
      expect(card.querySelector('svg')?.closest('[aria-hidden="true"]')).not.toBeNull();
      expect(card.closest('[hidden], [aria-hidden="true"]')).toBeNull();
      expect(card.hasAttribute('data-docs-app-entry-path')).toBe(false);
      expect(card.hasAttribute('target')).toBe(false);
    }

    const descriptions = cards.map(card => card.querySelector('p')?.textContent ?? '');
    expect(descriptions[0]).toContain('PLaMo 3 Translate');
    expect(descriptions[0]).toMatch(locale === 'ja' ? /ブラウザ内/ : /in your browser/u);
    expect(descriptions[1]).toMatch(locale === 'ja' ? /録音して送った/ : /record and send/u);
    expect(descriptions[2]).toMatch(locale === 'ja' ? /選んだ接続先とモデル/ : /chosen connection and model/u);
    expect(descriptions[3]).toMatch(locale === 'ja' ? /順番に生成.*保存済み/ : /in order.*saved results/u);
    expect(descriptions[4]).toMatch(locale === 'ja' ? /文字の書き出し・表への整理/ : /text from images.*table/u);
    expect(descriptions[5]).toMatch(locale === 'ja' ? /Naidanの全体・グループ・チャット内/ : /across Naidan, a Chat Group or one Chat/u);
    expect(page.document.querySelectorAll('[data-testid="docs-home-feature-link"]')).toHaveLength(6);
    expect(page.document.querySelector('[data-testid="docs-home-features"] h2')).toBeNull();
  });

  it('keeps guide text in flexible three-, two- and one-column layouts without a fixed card height', () => {
    const source = readFileSync(new URL('../pages/index/index.vue', import.meta.url), 'utf8');
    const { descriptor } = parseSfc(source);
    const style = descriptor.styles[0];
    if (!style) {
      throw new Error('Missing homepage styles');
    }
    const compiled = compileStyle({ source: style.content, filename: 'index.vue', id: 'docs-home-guides', scoped: true });
    expect(compiled.errors).toEqual([]);
    const tree = parseCss(compiled.code);
    const columns: string[] = [];
    tree.walkRules(rule => {
      if (rule.selector.startsWith('.home-guide-list[')) {
        rule.walkDecls('grid-template-columns', declaration => {
          columns.push(declaration.value);
        });
      }
      if (rule.selector.startsWith('.home-guide-card[')) {
        rule.walkDecls(declaration => {
          expect(['min-height', 'max-height', 'overflow']).not.toContain(declaration.prop);
        });
      }
    });
    expect(columns).toEqual(['repeat(3, minmax(0, 1fr))', 'repeat(2, minmax(0, 1fr))', 'minmax(0, 1fr)']);
    const copyRules: string[] = [];
    tree.walkRules(rule => {
      if (rule.selector.startsWith('.home-guide-card-copy[')) {
        rule.walkDecls('overflow-wrap', declaration => {
          copyRules.push(declaration.value);
        });
      }
    });
    expect(copyRules).toContain('anywhere');
  });
});
