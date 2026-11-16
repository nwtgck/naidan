import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { compileStyle, parse } from '@vue/compiler-sfc';
import postcss from 'postcss';
import TranslationPage from '../pages/translation/index.vue';
import TranslationGuideStep from '../components/demos/TranslationGuideStep.vue';
import { messages as en } from '../pages/translation/messages/en';
import { messages as ja } from '../pages/translation/messages/ja';
import { messages as commonEn } from '../messages/common/en';
import { messages as commonJa } from '../messages/common/ja';
import { parsePage } from './site.test-support';

describe('translation guide', () => {
  it.each([
    { locale: 'en' as const, s: en, common: commonEn },
    { locale: 'ja' as const, s: ja, common: commonJa },
  ])('renders a complete localized guide with an app entry and distinct storage boundaries in $locale', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(TranslationPage, { locale, s, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-translation"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect(article?.querySelector('[data-docs-app-entry-path]')?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/translation');
    expect([...article!.querySelectorAll('[data-docs-animation]')].map(scene => scene.getAttribute('data-docs-animation'))).toEqual([
      'translation-flow', 'translation-model', 'translation-translate', 'translation-options',
    ]);
    const rows = article?.querySelectorAll('[data-testid="translation-storage"] tbody tr');
    expect(rows).toHaveLength(3);
    expect(rows?.[0]?.textContent).toBe(s.model_and_automatic_settings + s.saved_in_settings);
    expect(rows?.[1]?.textContent).toBe(s.language_choices + s.kept_in_the_url);
    expect(rows?.[2]?.textContent).toBe(s.entered_text_and_options + s.kept_only_in_this_workspace);
    expect(article?.querySelector('[data-docs-related-guide] a')?.getAttribute('href')).toBe(`/docs/${locale}/in-browser-model/`);
    expect(article?.querySelector('script, [data-docs-island], button, input, select, textarea')).toBeNull();
  });

  it.each([{ locale: 'en', messages: en }, { locale: 'ja', messages: ja }])('keeps the model stage independent of source input and preserves reading order in $locale', async ({ messages }) => {
    const modelHtml = await renderToString(createSSRApp({ render: () => h(TranslationGuideStep, { stage: 'model', messages }) }));
    using model = parsePage({ html: modelHtml });
    expect(model.document.querySelector('.download-action')?.textContent).toBe(messages.download);
    expect(model.document.querySelector('.use-action')?.textContent).toBe(messages.use_this_model);
    expect(model.document.querySelector('[data-testid="translation-source-replica"] .editor-text')?.textContent).toBe(messages.enter_source_text);
    expect(model.document.querySelector('.source-character, .output-character')).toBeNull();
    const html = await renderToString(createSSRApp({ render: () => h(TranslationGuideStep, { stage: 'translate', messages }) }));
    using translation = parsePage({ html });
    expect([...translation.document.querySelectorAll('.source-character')].map(character => character.textContent).join('')).toBe(messages.sample_source);
    expect([...translation.document.querySelectorAll('.output-character')].map(character => character.textContent).join('')).toBe(messages.sample_translation);
    expect(translation.document.querySelector('.automatic-control')?.textContent).toBe(messages.automatic_translation);
    expect(translation.document.querySelector('.copy-action')?.textContent).toBe(messages.copy + messages.copied);
    expect(translation.document.querySelector('.language-field:last-child')?.textContent).toBe(messages.target_language + messages.japanese);
  });

  it.each([
    '../components/demos/TranslationFlowDiagram.vue',
    '../components/demos/TranslationGuideStep.vue',
  ])('compiles scoped pause and reduced-motion rules for %s', file => {
    const filename = new URL(file, import.meta.url);
    const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname });
    expect(errors).toHaveLength(0);
    const style = descriptor.styles[0];
    if (!style) {
      throw new Error(`Missing style in ${file}`);
    }
    const compiled = compileStyle({ source: style.content, filename: filename.pathname, id: 'data-v-translation', scoped: true });
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.code).toContain('html:has(#docs-pause-motion:checked) .translation-');
    expect(compiled.code).not.toMatch(/html:has\(#docs-pause-motion:checked\)\s*\{/);
    expect(compiled.code).toContain('prefers-reduced-motion:reduce');
    if (file.endsWith('TranslationGuideStep.vue')) {
      const css = postcss.parse(style.content);
      const stoppedOutput: string[] = [];
      css.walkRules(rule => {
        if (rule.selectors.some(selector => selector.includes('html:has(#docs-pause-motion:checked)') && selector.endsWith('.output-character'))) {
          rule.walkDecls('opacity', declaration => {
            stoppedOutput.push(declaration.value);
          });
        }
      });
      expect(stoppedOutput).toContain('1');
      expect(compiled.code).toContain('translate(var(--output-x),-106px)');
    }
  });

  it.each([274, 314, 554, 714])('keeps both focused editors inside a %ipx narrow camera without shrinking their text', cameraWidth => {
    const filename = new URL('../components/demos/TranslationGuideStep.vue', import.meta.url);
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname });
    const css = postcss.parse(descriptor.styles[0]?.content ?? '');
    const narrowValues = new Map<string, string>();
    css.walkAtRules('container', container => {
      container.walkRules(rule => {
        if (rule.selectors.includes('.translation-canvas')) {
          rule.walkDecls(declaration => {
            narrowValues.set(declaration.prop, declaration.value);
          });
        }
      });
    });
    const panelRule = /^min\((\d+)px,calc\(100cqw - (\d+)px\)\)$/.exec(narrowValues.get('--panel-width') ?? '');
    expect(panelRule).not.toBeNull();
    const panelWidth = Math.min(Number(panelRule![1]), cameraWidth - Number(panelRule![2]));
    const sourceLeft = 48 + 18;
    const outputLeft = sourceLeft + panelWidth + 14;
    const sourceOffset = -52;
    const outputOffset = -66 - panelWidth;
    for (const left of [sourceLeft + sourceOffset, outputLeft + outputOffset]) {
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left + panelWidth).toBeLessThanOrEqual(cameraWidth - 2);
    }
    expect(narrowValues.get('transform')).not.toContain('scale');
  });
});
