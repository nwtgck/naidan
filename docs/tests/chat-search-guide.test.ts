import { readFileSync } from 'node:fs';
import { compileStyle, parse } from '@vue/compiler-sfc';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import ChatSearchGuide from '../pages/chat-search/index.vue';
import ChatSearchGuideStep from '../components/demos/ChatSearchGuideStep.vue';
import { messages as english } from '../pages/chat-search/messages/en';
import { messages as japanese } from '../pages/chat-search/messages/ja';
import { messages as commonEnglish } from '../messages/common/en';
import { messages as commonJapanese } from '../messages/common/ja';
import { parsePage } from './site.test-support';

const filename = new URL('../components/demos/ChatSearchGuideStep.vue', import.meta.url);

function demoStyles() {
  const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname });
  expect(errors).toHaveLength(0);
  const source = descriptor.styles[0]?.content;
  if (source === undefined) {
    throw new Error('Missing Chat Search demo CSS');
  }
  const compiled = compileStyle({ source, filename: filename.pathname, id: 'data-v-test', scoped: true });
  expect(compiled.errors).toHaveLength(0);
  return { source: postcss.parse(source), compiled: postcss.parse(compiled.code) };
}

describe('Chat Search guide', () => {
  it.each([
    { locale: 'en', s: english, common: commonEnglish },
    { locale: 'ja', s: japanese, common: commonJapanese },
  ] as const)('renders the app search workflow and AI follow-up as readable $locale HTML', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp(ChatSearchGuide, { locale, s, common }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-chat-search"]');
    expect(article?.querySelector('[data-docs-app-entry-path]')?.getAttribute('data-docs-app-entry-path')).toBe('/#/');
    expect([...article?.querySelectorAll(':scope > section h2[id]') ?? []].map(heading => heading.id)).toEqual([
      'search-global', 'search-target', 'search-open', 'search-return',
    ]);
    expect(article?.querySelectorAll('[data-testid="chat-search-modes"] tbody tr')).toHaveLength(3);
    expect([...article?.querySelectorAll('[data-docs-related-guide] a') ?? []].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/wesh-sysfs/`, `/docs/${locale}/chat-branching/`,
    ]);
    const demos = [...article?.querySelectorAll('[data-docs-animation]') ?? []];
    expect(demos.map(demo => demo.getAttribute('data-docs-animation'))).toEqual([
      'chat-search-find', 'chat-search-group', 'chat-search-chat', 'chat-search-open',
    ]);
    for (const demo of demos) {
      expect(demo.querySelector('button, input, select, [tabindex], script')).toBeNull();
    }
    expect(article?.querySelector('[data-docs-island]')).toBeNull();
  });

  it.each([
    { messages: english, chrome: commonEnglish },
    { messages: japanese, chrome: commonJapanese },
  ])('keeps group and Chat entry filters separate and opens the exact matched passage', async ({ messages, chrome }) => {
    for (const stage of ['find', 'group', 'chat', 'open'] as const) {
      const html = await renderToString(createSSRApp(ChatSearchGuideStep, { stage, messages, chrome }));
      using page = parsePage({ html });
      const demo = page.document.querySelector(`[data-testid="chat-search-step-${stage}"]`);
      expect(demo?.querySelector('[data-testid="chat-search-sidebar-entry"]')).not.toBeNull();
      const filter = demo?.querySelector('[data-testid="chat-search-target-filter"]');
      if (stage === 'group' || stage === 'chat') {
        expect(filter?.textContent).toBe(stage === 'group' ? messages.chat_group : messages.chat_title);
        expect(demo?.querySelector(`[data-testid="chat-search-${stage}-entry"] .search-choice`)?.textContent).toBe(stage === 'group' ? messages.search_in_group : messages.search_in_chat);
      } else {
        expect(filter).toBeNull();
      }
      expect(demo?.querySelector('.query-text')?.textContent).toBe(messages.search_keyword);
      expect(demo?.querySelector('[data-testid="chat-search-message-result"] p')?.textContent).toBe(messages.match_text);
      expect(demo?.querySelector('[data-testid="chat-search-message-result"] .alt-branch')?.textContent).toBe(messages.alt_branch);
      expect(demo?.querySelector('[data-testid="chat-search-opened-message"] p')?.textContent).toBe(messages.match_text);
      expect(demo?.querySelector('.branch-navigation')?.textContent).toBe('1 / 2');
    }
  });

  it('preserves complete result and opened-message poses for pause and reduced motion', () => {
    const { compiled } = demoStyles();
    for (const context of ['pause', 'reduced'] as const) {
      const declarations = new Map<string, Map<string, string>>();
      compiled.walkRules(rule => {
        const matchesContext = context === 'pause'
          ? rule.selector.includes('html:has(#docs-pause-motion:checked)')
          : rule.parent?.type === 'atrule' && rule.parent.name === 'media' && rule.parent.params === '(prefers-reduced-motion:reduce)';
        if (!matchesContext) {
          return;
        }
        for (const selector of rule.selectors) {
          const values = declarations.get(selector) ?? new Map<string, string>();
          rule.walkDecls(declaration => {
            values.set(declaration.prop, declaration.value);
          });
          declarations.set(selector, values);
        }
      });
      const value = ({ suffix, property }: { suffix: string; property: string }) => [...declarations].find(([selector]) => selector.endsWith(suffix))?.[1].get(property);
      expect(value({ suffix: '.search-camera[data-v-test] *', property: 'animation' })).toBe('none');
      expect(value({ suffix: '.search-camera .search-overlay[data-v-test]', property: 'opacity' })).toBe('1');
      expect(value({ suffix: '.search-camera .query-character[data-v-test]', property: 'opacity' })).toBe('1');
      expect(value({ suffix: '.stage-open .search-overlay[data-v-test]', property: 'opacity' })).toBe('0');
      expect(value({ suffix: '.search-camera .pointer[data-v-test]', property: 'opacity' })).toBe('0');
    }
  });

  it.each(['attribute', 'checkbox'] as const)('applies the compiled %s light-theme branch color to the camera without leaking to the document', themeControl => {
    const { compiled } = demoStyles();
    using page = parsePage({ html: `<!doctype html><html${themeControl === 'attribute' ? ' data-theme="light"' : ''}><body><input type="checkbox" id="docs-light-theme"${themeControl === 'checkbox' ? ' checked' : ''}><div class="search-camera" data-v-test></div></body></html>` });
    const camera = page.document.querySelector('.search-camera');
    const lightSelectors: string[] = [];
    let cameraColor: string | undefined;
    compiled.walkRules(rule => {
      rule.walkDecls('--search-branch', declaration => {
        for (const selector of rule.selectors) {
          if (camera?.matches(selector)) {
            cameraColor = declaration.value;
          }
          if (declaration.value === '#92400e') {
            lightSelectors.push(selector);
            expect(page.document.documentElement.matches(selector)).toBe(false);
          }
        }
      });
    });
    expect(lightSelectors).toEqual([
      'html[data-theme="light"] .search-camera[data-v-test]',
      'html:has(#docs-light-theme:checked) .search-camera[data-v-test]',
    ]);
    expect(cameraColor).toBe('#92400e');
  });

  it.each([274, 320, 559, 560, 561, 700, 720])('keeps the Chat entry, menu, and result within a %ipx camera', async cameraWidth => {
    const { source } = demoStyles();
    const declaration = ({ selector, property, narrow }: { selector: string; property: string; narrow: boolean }): string => {
      let value: string | undefined;
      source.walkRules(rule => {
        const inNarrow = rule.parent?.type === 'atrule' && rule.parent.name === 'container' && rule.parent.params === '(max-width:560px)';
        if (inNarrow === narrow && rule.selectors.includes(selector)) {
          rule.walkDecls(property, item => {
            value = item.value;
          });
        }
      });
      if (value === undefined) {
        throw new Error(`Missing ${selector} ${property}`);
      }
      return value;
    };
    const canvasWidth = Number.parseFloat(declaration({ selector: '.app-canvas', property: 'width', narrow: false }));
    const pan = declaration({ selector: '.stage-chat .app-canvas', property: 'left', narrow: false }).match(/^min\(0px,calc\(100cqw - ([\d.]+)px\)\)$/u);
    expect(Number(pan?.[1])).toBe(canvasWidth);
    const canvasLeft = Math.min(0, cameraWidth - Number(pan?.[1]));
    const canvasRight = canvasLeft + canvasWidth;
    const menuWidth = Number.parseFloat(declaration({ selector: '.chat-menu', property: 'width', narrow: false }));
    const menuRight = Number.parseFloat(declaration({ selector: '.chat-menu', property: 'right', narrow: false }));
    expect(canvasRight - menuRight - menuWidth).toBeGreaterThanOrEqual(0);
    expect(canvasRight - menuRight).toBeLessThanOrEqual(cameraWidth);

    const html = await renderToString(createSSRApp(ChatSearchGuideStep, { stage: 'chat', messages: english, chrome: commonEnglish }));
    using page = parsePage({ html });
    const header = page.document.querySelector('.chat-header');
    const leadingIconWidth = Number(header?.querySelector(':scope > svg')?.getAttribute('width'));
    const triggerIconWidth = Number(header?.querySelector('.header-more > svg:not(.pointer)')?.getAttribute('width'));
    const pointerWidth = Number(header?.querySelector('.pointer')?.getAttribute('width'));
    const headerRightPadding = Number.parseFloat(declaration({ selector: '.chat-header', property: 'padding', narrow: false }).split(/\s+/u)[1] ?? '');
    const triggerPadding = Number.parseFloat(declaration({ selector: '.group-more', property: 'padding', narrow: false }));
    const triggerRight = canvasRight - headerRightPadding;
    const triggerLeft = triggerRight - triggerIconWidth - 2 * triggerPadding;
    expect(triggerLeft).toBeGreaterThanOrEqual(0);
    expect(triggerRight).toBeLessThanOrEqual(cameraWidth);
    const pointerRightOffset = Number.parseFloat(declaration({ selector: '.entry-pointer', property: 'right', narrow: false }));
    expect(triggerRight - pointerRightOffset - pointerWidth).toBeGreaterThanOrEqual(0);
    expect(triggerRight - pointerRightOffset).toBeLessThanOrEqual(cameraWidth);

    const headerPadding = declaration({ selector: '.stage-chat .chat-header', property: 'padding-left', narrow: false }).match(/^max\(([\d.]+)px,calc\(([\d.]+)px - 100cqw\)\)$/u);
    const headerLeftPadding = Math.max(Number(headerPadding?.[1]), Number(headerPadding?.[2]) - cameraWidth);
    const sidebarWidth = Number.parseFloat(declaration({ selector: '.app-canvas', property: 'grid-template-columns', narrow: false }));
    const gap = Number.parseFloat(declaration({ selector: '.chat-header', property: 'gap', narrow: false }));
    const iconLeft = canvasLeft + sidebarWidth + headerLeftPadding;
    expect(iconLeft).toBeGreaterThanOrEqual(0);
    const titleLeft = iconLeft + leadingIconWidth + gap;
    const availableTitleWidth = triggerLeft - gap - titleLeft;
    const titleFontSize = Number.parseFloat(declaration({ selector: '.chat-header strong', property: 'font-size', narrow: false }));
    for (const messages of [english, japanese]) {
      expect([...messages.chat_title].length * titleFontSize).toBeLessThanOrEqual(availableTitleWidth);
    }
    expect(declaration({ selector: '.search-body', property: 'grid-template-columns', narrow: true })).toBe('minmax(0,1fr)');
    expect(declaration({ selector: '.stage-open .app-canvas', property: 'width', narrow: false })).toBe('100cqw');
    expect(declaration({ selector: '.search-camera', property: 'height', narrow: false })).toBe('390px');
  });
});
