import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { compileStyle, parse } from '@vue/compiler-sfc';
import postcss from 'postcss';
import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';
import MultiPromptImageGuide from '../pages/image-generation-multi-prompt/index.vue';
import MultiPromptImageGuideStep from '../components/demos/MultiPromptImageGuideStep.vue';
import { messages as english } from '../pages/image-generation-multi-prompt/messages/en';
import { messages as japanese } from '../pages/image-generation-multi-prompt/messages/ja';
import { messages as commonEn } from '../messages/common/en';
import { messages as commonJa } from '../messages/common/ja';
import { parsePage } from './site.test-support';

describe('multiple prompt image guide', () => {
  it.each([
    { locale: 'en', copy: english, common: commonEn },
    { locale: 'ja', copy: japanese, common: commonJa },
  ] as const)('keeps the complete $locale workflow readable in server-rendered HTML', async ({ locale, copy, common }) => {
    const html = await renderToString(createSSRApp(MultiPromptImageGuide, { s: copy, locale, common }));
    using page = parsePage({ html });
    expect(page.document.querySelector('h1')?.textContent).toBe(copy.title);
    expect(page.document.querySelector('[data-docs-app-entry-path]')?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/image-generation/');
    const steps = [...page.document.querySelectorAll('.walkthrough-step')];
    expect(steps).toHaveLength(7);
    for (const step of steps) {
      expect([...step.children].slice(0, 3).map(child => child.tagName)).toEqual(['H2', 'P', 'FIGURE']);
      expect(step.querySelector('figcaption')?.textContent?.trim()).toBeTruthy();
    }
    expect(steps.map(step => step.querySelector('[data-docs-animation]')?.getAttribute('data-docs-animation'))).toEqual([
      'multi-prompt-common', 'multi-prompt-inputs', 'multi-prompt-overrides', 'multi-prompt-generate', 'multi-prompt-compare', 'multi-prompt-save', 'multi-prompt-paste',
    ]);
    const changes = page.document.querySelector('[data-testid="multi-prompt-step-overrides"] [data-testid="multi-prompt-individual-settings"]');
    expect(changes?.textContent).toContain('768');
    expect([...changes?.querySelectorAll('.override-value') ?? []].map(field => field.textContent)).toEqual(['768', '768']);
    expect(changes?.querySelector('.inherited')?.textContent).toContain(copy.shared);
    const sequence = page.document.querySelector('[data-testid="multi-prompt-step-generate"]');
    expect([...sequence?.querySelectorAll('.monitor-frame .monitor-image img') ?? []].map(image => image.getAttribute('src'))).toEqual(expect.arrayContaining([
      expect.stringContaining('flying-kitten.webp'), expect.stringContaining('garden-kitten.webp'), expect.stringContaining('bookshelf-kitten.webp'),
    ]));
    expect(sequence?.textContent).toContain(copy.request_one);
    expect(sequence?.textContent).toContain(copy.request_two);
    expect(sequence?.textContent).toContain(copy.request_three);
    const comparison = page.document.querySelector('[data-testid="multi-prompt-comparison"]');
    expect(comparison?.querySelectorAll('.comparison-images img')).toHaveLength(2);
    expect(comparison?.textContent).toContain(copy.sky_prompt);
    expect(comparison?.textContent).toContain(copy.garden_prompt);
    const saved = page.document.querySelector('[data-testid="multi-prompt-step-save"]');
    expect(saved?.querySelector('[data-testid="multi-prompt-operation"] .download')?.textContent).toContain(copy.download_results_zip);
    expect(saved?.querySelector('[data-testid="multi-prompt-zip-confirmation"]')?.textContent).toContain(copy.zip_notice);
    expect(page.document.querySelectorAll('figure button, figure input, figure a, figure textarea')).toHaveLength(0);
    const links = [...page.document.querySelectorAll('article a')].map(link => link.getAttribute('href'));
    expect(links).toEqual(expect.arrayContaining([`/docs/${locale}/image-generation/`, `/docs/${locale}/workflow/`, `/docs/${locale}/endpoint-type-naidan-rpc/`]));
  });

  it('accepts every displayed YAML and JSONL example with the real image input parser', async () => {
    const repository = fileURLToPath(new URL('../..', import.meta.url));
    const server = await createServer({ configFile: false, root: repository, appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false }, resolve: { alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) } }, optimizeDeps: { noDiscovery: true, include: [] } });
    await using _cleanup = { [Symbol.asyncDispose]: () => server.close() };
    const parser: unknown = await server.ssrLoadModule('/src/features/image-generation/composition/input.ts');
    if (typeof parser !== 'object' || parser === null
      || !('parseImageGenerationInput' in parser) || typeof parser.parseImageGenerationInput !== 'function') {
      throw new Error('The app must export its image generation input parser.');
    }
    for (const { locale, copy, common } of [{ locale: 'en', copy: english, common: commonEn }, { locale: 'ja', copy: japanese, common: commonJa }] as const) {
      const html = await renderToString(createSSRApp(MultiPromptImageGuide, { s: copy, locale, common }));
      using page = parsePage({ html });
      for (const format of ['YAML', 'JSONL'] as const) {
        const text = page.document.querySelector(`[data-testid="multi-prompt-${format.toLowerCase()}"]`)?.textContent;
        if (!text) {
          throw new Error('Missing paste example');
        }
        const parsed: unknown = await parser.parseImageGenerationInput({ text });
        expect(parsed).toEqual({ format, inputs: [copy.sky_prompt, copy.garden_prompt, copy.bookshelf_prompt].map(prompt => ({ prompt, count: 1 })) });
      }
    }
  });

  it('preserves fixed cameras and the ZIP confirmation after scoped pause and reduced-motion compilation', async () => {
    const filename = fileURLToPath(new URL('../components/demos/MultiPromptImageGuideStep.vue', import.meta.url));
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
    const style = descriptor.styles[0];
    if (!style) {
      throw new Error('Missing demo styles');
    }
    const compiled = compileStyle({ filename, source: style.content, scoped: true, id: 'data-v-multi-prompt' });
    expect(compiled.errors).toHaveLength(0);
    const root = postcss.parse(compiled.code);
    const cameraRules: string[] = [], transforms: string[] = [], stoppingRules: string[] = [];
    root.walkRules(rule => {
      if (rule.selector === '.multi-camera[data-v-multi-prompt]') {
        rule.walkDecls('height', declaration => {
          cameraRules.push(declaration.value);
        });
        rule.walkDecls('--editor-width', declaration => {
          cameraRules.push(declaration.value);
        });
        rule.walkDecls('--results-width', declaration => {
          cameraRules.push(declaration.value);
        });
      }
      const pausedCanvas = rule.selector === 'html:has(#docs-pause-motion:checked) .multi-camera .canvas[data-v-multi-prompt]';
      const reducedCanvas = rule.selector === '.canvas[data-v-multi-prompt]' && rule.parent?.type === 'atrule' && rule.parent.params === '(prefers-reduced-motion:reduce)';
      if (pausedCanvas || reducedCanvas) {
        rule.walkDecls('transform', declaration => {
          transforms.push(declaration.value);
        });
      }
      if (rule.selector.includes('html:has(#docs-pause-motion:checked)') || rule.parent?.type === 'atrule' && rule.parent.params === '(prefers-reduced-motion:reduce)') {
        rule.walkDecls('animation', declaration => {
          stoppingRules.push(`${declaration.value}:${declaration.important}`);
        });
      }
    });
    expect(cameraRules).toEqual(expect.arrayContaining(['460px', 'min(370px,calc(100cqw - 28px))', 'min(470px,calc(100cqw - 28px))']));
    expect(transforms).toEqual(['translate(var(--rest-x),var(--rest-y))', 'translate(var(--rest-x),var(--rest-y))']);
    expect(stoppingRules).toEqual(['none:true', 'none:true']);

    const articleParagraphRules: string[] = [], reducedRules: string[] = [];
    postcss.parse(readFileSync(new URL('../styles/site.css', import.meta.url), 'utf8')).walkRules(rule => {
      if (rule.selectors.includes('.prose p')) {
        articleParagraphRules.push(rule.toString());
      }
    });
    root.walkAtRules('media', rule => {
      if (rule.params.includes('prefers-reduced-motion')) {
        reducedRules.push(...rule.nodes?.map(node => node.toString()) ?? []);
      }
    });
    expect(articleParagraphRules.length).toBeGreaterThan(0);
    for (const copy of [english, japanese]) {
      const html = await renderToString(createSSRApp(MultiPromptImageGuideStep, { stage: 'save', messages: copy }));
      for (const mode of ['pause', 'reduced']) {
        using page = parsePage({ html: `<input id="docs-pause-motion" type="checkbox"><article class="prose">${html}</article>` });
        const { document } = page, window = document.defaultView;
        const camera = document.querySelector<HTMLElement>('.stage-save');
        const dialog = document.querySelector<HTMLElement>('[data-testid="multi-prompt-zip-confirmation"]');
        const paragraph = dialog?.querySelector('p'), title = dialog?.querySelector('strong'), confirm = dialog?.querySelector('.action');
        if (!window || !camera || !dialog || !paragraph || !title || !confirm) {
          throw new Error('Missing ZIP confirmation content');
        }
        document.querySelectorAll('.multi-camera, .multi-camera *').forEach(element => element.setAttribute('data-v-multi-prompt', ''));
        const sheet = document.createElement('style');
        sheet.textContent = `${articleParagraphRules.join('\n')}\n${compiled.code}\n${mode === 'reduced' ? reducedRules.join('\n') : ''}`;
        document.head.append(sheet);
        if (mode === 'pause') {
          const control = document.querySelector<HTMLInputElement>('#docs-pause-motion');
          if (!control) {
            throw new Error('Missing motion control');
          }
          control.checked = true;
        }
        const cameraStyle = window.getComputedStyle(camera), dialogStyle = window.getComputedStyle(dialog);
        const paragraphStyle = window.getComputedStyle(paragraph), titleStyle = window.getComputedStyle(title), confirmStyle = window.getComputedStyle(confirm);
        expect(dialogStyle.opacity).not.toBe('0');
        expect(paragraph.textContent).toBe(copy.zip_notice);
        expect(confirm.textContent).toBe(copy.confirm);
        // Article prose has a larger line height. It must not expand this
        // camera's confirmation beyond the final action.
        expect(paragraphStyle.lineHeight).toBe('1.5');
        const paragraphLineHeight = Number.parseFloat(paragraphStyle.fontSize) * Number(paragraphStyle.lineHeight);
        const dialogTop = Number.parseFloat(dialogStyle.top) + Number.parseFloat(cameraStyle.getPropertyValue('--rest-y'));
        const border = 1;
        const reservedHeight = dialogTop + 2 * Number.parseFloat(dialogStyle.paddingTop) + 2 * border
          + Number.parseFloat(titleStyle.fontSize) * 1.5
          + Number.parseFloat(paragraphStyle.marginTop) + Number.parseFloat(paragraphStyle.marginBottom)
          + Number.parseFloat(confirmStyle.minHeight);
        // At a 204px text width, the English notice uses at most twelve lines
        // in Noto Sans, Noto Sans CJK and DejaVu Sans measurements; Japanese
        // uses nine lines in Noto Sans CJK.
        // Reserve a thirteenth line for font variation; wider cameras cannot
        // require more lines. This is a CSS budget, not a browser layout test.
        for (const cameraWidth of [274, 554, 678]) {
          const dialogWidth = Math.min(470, cameraWidth - 28);
          expect(dialogWidth - 2 * Number.parseFloat(dialogStyle.paddingTop) - 2 * border).toBeGreaterThanOrEqual(204);
          expect(12 + dialogWidth).toBeLessThanOrEqual(cameraWidth);
          expect(reservedHeight + 13 * paragraphLineHeight).toBeLessThanOrEqual(Number.parseFloat(cameraStyle.height) - 2 * border);
        }
      }
    }
  });
});
