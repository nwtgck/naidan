import { readFileSync } from 'node:fs';
import { compileStyle, parse } from '@vue/compiler-sfc';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { updateAppEntryLinks } from '../client/app-entry-enhancement';
import ImageUnderstandingPage from '../pages/image-understanding/index.vue';
import { messages as en } from '../pages/image-understanding/messages/en';
import { messages as ja } from '../pages/image-understanding/messages/ja';
import { messages as commonEn } from '../messages/common/en';
import { messages as commonJa } from '../messages/common/ja';
import { parsePage } from './site.test-support';

describe('image questions guide', () => {
  it.each([
    { locale: 'en', s: en, common: commonEn },
    { locale: 'ja', s: ja, common: commonJa },
  ] as const)('connects preparation, an image question, and a follow-up in static $locale HTML', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp(ImageUnderstandingPage, { s, locale, common }));
    using page = parsePage({ html });
    const { document } = page;
    expect(document.querySelector('h1')?.textContent).toBe(s.title);
    expect(document.querySelector('.app-entry-intro [data-docs-app-entry-path]')?.getAttribute('data-docs-app-entry-path')).toBe('/#/');
    expect(document.querySelector('.app-entry-intro [data-docs-app-entry-path-text]')?.textContent).toBe('Naidan');
    updateAppEntryLinks({ document, locationHref: `https://docs-preview.example/docs/${locale}/image-understanding/` });
    expect(document.querySelector('.app-entry-intro [data-docs-app-entry-path]')?.getAttribute('href')).toBe('https://docs-preview.example/#/');
    expect(document.querySelector('.app-entry-intro [data-docs-app-entry-path-text]')?.textContent).toBe('Naidan');
    const preparation = document.querySelector('section[aria-labelledby="image-understanding-prepare"]');
    expect(preparation?.textContent).toContain('mmproj');
    expect(preparation?.querySelector('[data-testid="image-understanding-model-configuration"] .repository')?.textContent).toBe(s.sample_repository);
    expect(preparation?.querySelector('[data-testid="image-understanding-companion"]')?.textContent).toContain(s.multimodal_quantization);
    expect(preparation?.querySelector('.use-model')?.textContent).toBe(s.use_model_in_this_chat);
    expect(preparation?.textContent).toContain('OPFS');
    const attachment = document.querySelector('[data-testid="image-understanding-attach"]');
    expect(attachment?.querySelector('[data-testid="docs-chat-input-attach"] .attach-menu strong')?.textContent).toBe(s.files);
    expect(attachment?.querySelector('[data-testid="image-understanding-attachment-preview"] img')?.getAttribute('src')).toContain('flying-kitten.webp');
    const chat = document.querySelector('[data-testid="image-understanding-ask"]');
    expect([...chat?.querySelectorAll('.message p') ?? []].map(message => message.textContent)).toEqual([
      s.photo_prompt, s.photo_answer, s.followup_prompt, s.followup_answer,
    ]);
    const stream = chat?.querySelector('[data-testid="image-understanding-photo-answer"] .stream');
    const delays = [...stream?.querySelectorAll('.stream-character') ?? []].map(character => Number(character.getAttribute('style')?.match(/[\d.]+/)?.[0]));
    expect(delays.length).toBeGreaterThan(20);
    expect(delays.every((delay, index) => index === 0 || delay >= (delays[index - 1] ?? 0))).toBe(true);
    expect(delays.at(-1)).toBeGreaterThan(2);
    expect(document.querySelectorAll('[data-docs-animation]')).toHaveLength(6);
    expect(document.querySelectorAll('figure button, figure input, figure a, [data-docs-island], script')).toHaveLength(0);
    expect([...document.querySelectorAll('[data-docs-related-guide] a')].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/endpoint-type-llama-cpp-browser/`, `/docs/${locale}/file-access/`,
    ]);
  });

  it.each([
    { locale: 'en', s: en, common: commonEn },
    { locale: 'ja', s: ja, common: commonJa },
  ] as const)('keeps the $locale notice, written-out text, and table consistent', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp(ImageUnderstandingPage, { s, locale, common }));
    using page = parsePage({ html });
    const notice = page.document.querySelector('[data-testid="image-understanding-transcribe"] .message-notice');
    const sourceLines = [...notice?.querySelectorAll('text') ?? []].map(line => line.textContent);
    const transcription = page.document.querySelector('[data-testid="image-understanding-transcribed-text"]');
    expect(transcription?.textContent?.split('\n')).toEqual(sourceLines);
    const table = page.document.querySelector('[data-testid="image-understanding-result-table"]');
    const rows = [...table?.querySelectorAll('tbody tr') ?? []].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent));
    expect(rows.flat()).toEqual(sourceLines.slice(1));
    expect([...table?.querySelectorAll('th') ?? []].map(cell => cell.textContent)).toEqual([s.table_event, s.table_time, s.table_place]);
    expect(page.document.querySelector('section[aria-labelledby="image-understanding-check"]')?.textContent).toContain(s.check_result);
  });

  it('keeps completed results readable when motion stops and applies narrow camera offsets to descendants', () => {
    const filename = new URL('../components/demos/ImageUnderstandingGuideStep.vue', import.meta.url);
    const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname });
    expect(errors).toHaveLength(0);
    const style = descriptor.styles[0];
    if (!style) {
      throw new Error('Missing image guide styles');
    }
    const compiled = compileStyle({ source: style.content, filename: filename.pathname, id: 'data-v-image-guide', scoped: true });
    expect(compiled.errors).toHaveLength(0);
    const css = postcss.parse(compiled.code);
    const pauseSelectors: string[] = [];
    css.walkRules(rule => {
      if (rule.selector.includes('#docs-pause-motion:checked')) {
        pauseSelectors.push(...rule.selectors);
      }
    });
    expect(pauseSelectors.some(selector => selector.startsWith('html:has(#docs-pause-motion:checked) .image-camera') && selector.includes('.thread-messages'))).toBe(true);
    expect(pauseSelectors.some(selector => selector === 'html:has(#docs-pause-motion:checked)')).toBe(false);
    const narrowOffsetSelectors: string[] = [];
    css.walkAtRules('container', atRule => {
      atRule.walkDecls('--thread-rest-y', declaration => {
        if (declaration.parent?.type === 'rule') {
          narrowOffsetSelectors.push(declaration.parent.selector);
        }
      });
    });
    expect(narrowOffsetSelectors).toHaveLength(3);
    expect(narrowOffsetSelectors.every(selector => selector.includes(' .thread-messages'))).toBe(true);
    const reduced = css.nodes.find(node => node.type === 'atrule' && node.name === 'media' && node.params.includes('prefers-reduced-motion'));
    expect(reduced?.toString()).toContain('.thread-messages');
    expect(reduced?.toString()).toContain('animation: none!important');
  });
});
