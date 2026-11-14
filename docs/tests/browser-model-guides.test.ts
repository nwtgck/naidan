import { readFileSync } from 'node:fs';
import { compileStyle, parse } from '@vue/compiler-sfc';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import LlamaGuide from '../pages/endpoint-type-llama-cpp-browser/index.vue';
import TransformersGuide from '../pages/endpoint-type-transformers-js/index.vue';
import BrowserModelsGuide from '../pages/in-browser-model/index.vue';
import InBrowserModelSettingsStep from '../components/demos/InBrowserModelSettingsStep.vue';
import { messages as llamaEnglish } from '../pages/endpoint-type-llama-cpp-browser/messages/en';
import { messages as llamaJapanese } from '../pages/endpoint-type-llama-cpp-browser/messages/ja';
import { messages as transformersEnglish } from '../pages/endpoint-type-transformers-js/messages/en';
import { messages as transformersJapanese } from '../pages/endpoint-type-transformers-js/messages/ja';
import { messages as overviewEnglish } from '../pages/in-browser-model/messages/en';
import { messages as overviewJapanese } from '../pages/in-browser-model/messages/ja';
import { messages as commonEnglish } from '../messages/common/en';
import { messages as commonJapanese } from '../messages/common/ja';
import { updateAppEntryLinks } from '../client/app-entry-enhancement';
import { parsePage } from './site.test-support';

// README's Text Generation model links are the source of this guide's shortlist.
const readmeTextModels = [
  ['Gemma 4 E2B it', 'hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf:Q4_0'],
  ['Gemma 4 E4B it', 'hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf:Q4_0'],
  ['Gemma 4 26B-A4B it', 'hf.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf:Q4_0'],
  ['gpt-oss-20b', 'hf.co/ggml-org/gpt-oss-20b-GGUF:MXFP4'],
  ['Qwen3.5 9B', 'hf.co/lmstudio-community/Qwen3.5-9B-GGUF:Q4_K_M'],
  ['Qwen3.6 35B-A3B', 'hf.co/ggml-org/Qwen3.6-35B-A3B-GGUF:Q4_K_M'],
  ['Qwen3.8 27B', 'hf.co/ggml-org/Qwen3.8-27B-GGUF:Q4_K_M'],
  ['LFM2.5 230M', 'hf.co/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M'],
  ['LFM2.5 2.6B', 'hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M'],
  ['Muse-Glimmer 30B', 'hf.co/meta-models/Muse-Glimmer-30B-GGUF:Q4_K_M'],
  ['SmolLM2 135M Instruct', 'hf.co/lmstudio-community/SmolLM2-135M-Instruct-GGUF:Q4_K_M'],
] as const;

describe('browser model guides', () => {
  it.each([
    { locale: 'en', s: llamaEnglish, common: commonEnglish },
    { locale: 'ja', s: llamaJapanese, common: commonJapanese },
  ] as const)('keeps import and download as separate routes to an explicit llama.cpp default in $locale', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(LlamaGuide, { s, locale, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-models-llama-cpp-browser"]');
    const modelLinks = [...(article?.querySelectorAll('.quick-model-list a') ?? [])];
    expect(modelLinks.map(link => {
      const url = new URL(link.getAttribute('href') ?? '');
      expect(url.hash).toBe('');
      expect(url.pathname.startsWith('/llama-cpp-browser/hf.co/')).toBe(true);
      expect(url.origin).toBe('https://naidan.nwtgck.org');
      expect(link.querySelector('[data-docs-external-icon], .sr-only')).toBeNull();
      return [link.textContent?.trim(), `${url.pathname.slice('/llama-cpp-browser/'.length)}:${url.searchParams.get('quant')}`];
    })).toEqual(readmeTextModels);
    for (const origin of ['https://naidan.pages.dev', 'http://localhost:5173', 'https://preview.example']) {
      updateAppEntryLinks({ document: page.document, locationHref: `${origin}/docs/${locale}/endpoint-type-llama-cpp-browser/` });
      for (const link of modelLinks) {
        const url = new URL(link.getAttribute('href') ?? '');
        expect(url.origin).toBe(origin);
        expect(url.pathname.startsWith('/llama-cpp-browser/hf.co/')).toBe(true);
        expect(url.hash).toBe('');
      }
    }

    expect(article?.querySelectorAll('section.walkthrough-step')).toHaveLength(4);
    for (const stage of ['open', 'import', 'download', 'default']) {
      const scene = article?.querySelector(`[data-testid="llama-settings-${stage}"]`);
      expect(scene?.getAttribute('data-docs-animation')).toBe(`llama-settings-${stage}`);
      expect(scene?.querySelector('[data-docs-camera-canvas]')).not.toBeNull();
    }
    expect(article?.querySelector('[data-testid="llama-settings-import"]')?.textContent).toContain(s.choose_gguf_files);
    expect(article?.querySelector('[data-testid="llama-settings-import"] .imported-result')?.textContent).toContain(s.sample_model_id);
    expect([...article?.querySelectorAll('.import-modes > span') ?? []].map(mode => mode.textContent?.trim())).toEqual([s.load_model, s.link_folder]);
    expect(article?.querySelector('.import-modes .selected')?.textContent).toContain(s.load_model);
    const copyChoice = article?.querySelector('[data-testid="llama-import-copy-off"]');
    expect(copyChoice?.textContent).toContain(s.copy_model_files);
    expect(copyChoice?.querySelector('.toggle-look.on')).toBeNull();
    expect(article?.querySelector('[data-testid="llama-settings-import"] .temporary-save-notice')?.textContent).toContain(s.save_in_browser);
    expect(article?.querySelector('[data-testid="llama-settings-import"] .temporary-folders')?.textContent).toContain(s.open_model_folders);
    expect(article?.querySelectorAll('.storage-choices li')).toHaveLength(3);
    expect(article?.querySelector('[data-testid="llama-settings-download"] .repository-search')?.textContent).toContain(s.search);
    expect(article?.querySelector('[data-testid="llama-settings-download"] .repository-result .repository-open')?.textContent).toContain(s.entered_repository);
    expect(article?.querySelector('.repository-pointer')?.parentElement?.classList.contains('repository-open')).toBe(true);
    expect(article?.querySelector('.search-pointer')?.parentElement?.textContent).toContain(s.search);
    expect(article?.querySelector('[data-testid="llama-settings-download"] .repository-preview')?.textContent).toContain(s.multimodal_quantization);
    expect(article?.querySelector('[data-testid="llama-settings-download"] .repository-preview')?.textContent).toContain(s.sample_companion);
    expect(article?.querySelector('[data-testid="llama-settings-download"] .download-size')?.textContent).toContain(s.sample_download_size);
    expect(article?.querySelector('[data-testid="llama-settings-download"]')?.textContent).toContain(s.download_destination);
    expect(article?.querySelector('[data-testid="llama-settings-download"]')?.textContent).toContain(s.imported_models);
    expect(article?.querySelector('[data-testid="llama-settings-download"] .repository-search')?.textContent).toContain(s.find_models);
    expect(article?.querySelector('[data-testid="llama-settings-download"] .model-row.downloaded-result')?.textContent).toContain(s.downloaded_model_id);
    expect(article?.querySelector('[data-testid="llama-settings-default"]')?.textContent).toContain(s.confirm_default_model);
    expect(article?.querySelector('[data-testid="llama-settings-default"] .previous-download-result')?.textContent).toContain(s.downloaded_model_id);
    expect(article?.querySelector('[data-testid="llama-settings-default"] .confirm-panel')?.textContent).toContain(s.default_model_scope);
    expect(article?.textContent).toContain(locale === 'en' ? 'Standalone' : 'スタンドアロン');
    expect(article?.textContent).toContain('JSPI');
    expect(article?.textContent).toContain(locale === 'en' ? 'Run in your browser' : 'ブラウザ内で動かす');
    expect(article?.textContent).not.toContain(locale === 'en' ? 'Start with this model' : 'このモデルで始める');
    expect(article?.querySelector('.app-entry-onboarding')).toBeNull();
    expect(article?.querySelector('button, input, select, script')).toBeNull();
  });

  it('keeps the model cameras stable and their completed states readable when motion stops', () => {
    const filename = new URL('../components/demos/InBrowserModelSettingsStep.vue', import.meta.url);
    const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname });
    expect(errors).toHaveLength(0);
    const style = descriptor.styles[0];
    if (!style) {
      throw new Error('Missing browser model settings styles');
    }
    const compiled = compileStyle({ source: style.content, filename: filename.pathname, id: 'data-v-browser-model-test', scoped: true });
    expect(compiled.errors).toHaveLength(0);
    const css = postcss.parse(compiled.code);
    const declarations = ({ selector, property }: { selector: string; property: string }) => {
      const values: string[] = [];
      css.walkRules(rule => {
        if (postcss.list.comma(rule.selector).includes(selector)) {
          rule.walkDecls(property, declaration => {
            values.push(declaration.value);
          });
        }
      });
      return values;
    };
    const scope = '[data-v-browser-model-test]';
    const stopped = 'html:has(#docs-pause-motion:checked) .browser-model-camera';
    expect(declarations({ selector: `.browser-model-camera${scope}`, property: 'height' })).toEqual(['340px', '320px']);
    expect(declarations({ selector: `${stopped} .camera-canvas${scope}`, property: 'transform' })).toEqual(['translate(var(--camera-end-x),var(--camera-end-y)) scale(var(--camera-end-z))']);
    expect(declarations({ selector: `${stopped} .pointer${scope}`, property: 'display' })).toEqual(['none']);
    for (const result of ['imported-result', 'downloaded-result', 'repository-result']) {
      expect(declarations({ selector: `${stopped} .${result}${scope}`, property: 'opacity' })).toEqual(['1']);
    }
    expect(declarations({ selector: `.pointer${scope}`, property: 'display' })).toEqual(['none']);
    expect(declarations({ selector: `.repository-open${scope}`, property: 'position' })).toEqual(['relative']);
  });

  it.each([320, 540, 541, 600, 620, 621, 714, 715, 744, 745, 1024])('keeps browser model fields and confirmation controls inside the camera at a %ipx viewport', async viewportWidth => {
    const filename = new URL('../components/demos/InBrowserModelSettingsStep.vue', import.meta.url);
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname });
    const css = postcss.parse(descriptor.styles[0]?.content ?? '');
    const siteCss = postcss.parse(readFileSync(new URL('../styles/site.css', import.meta.url), 'utf8'));
    const declarations = ({ element, stylesheet }: { element: Element; stylesheet: postcss.Root }) => {
      const values = new Map<string, string>();
      stylesheet.walkRules(rule => {
        for (let owner = rule.parent; owner && owner.type !== 'root'; owner = owner.parent) {
          if (owner.type !== 'atrule' || owner.name !== 'media') {
            return;
          }
          const condition = /^\((min|max)-width:\s*(\d+)px\)$/.exec(owner.params);
          if (!condition || (condition[1] === 'min' ? viewportWidth < Number(condition[2]) : viewportWidth > Number(condition[2]))) {
            return;
          }
        }
        if (element.matches(rule.selector)) {
          rule.walkDecls(declaration => {
            values.set(declaration.prop, declaration.value);
          });
        }
      });
      return values;
    };
    const required = ({ values, property }: { values: Map<string, string>; property: string }) => {
      const value = values.get(property);
      if (value === undefined) {
        throw new Error(`Missing geometry property ${property}`);
      }
      return value;
    };
    const length = ({ value, containerWidth, variables }: { value: string; containerWidth: number; variables: Map<string, string> }): number => {
      const expanded = value.replace(/var\((--[\w-]+)\)/g, (_match, property: string) => `${length({ value: required({ values: variables, property }), containerWidth, variables })}px`);
      const scalar = /^(-?[\d.]+)(?:px)?$/.exec(expanded);
      if (scalar) {
        return Number(scalar[1]);
      }
      const fitted = /^min\((-?[\d.]+)px,\s*calc\(100cqw ([+-]) ([\d.]+)px\)\)$/.exec(expanded);
      if (fitted) {
        return Math.min(Number(fitted[1]), containerWidth + (fitted[2] === '+' ? 1 : -1) * Number(fitted[3]));
      }
      const clamped = /^clamp\((-?[\d.]+)px,\s*calc\(100cqw - ([\d.]+)px\),\s*(-?[\d.]+)px\)$/.exec(expanded);
      if (clamped) {
        return Math.max(Number(clamped[1]), Math.min(containerWidth - Number(clamped[2]), Number(clamped[3])));
      }
      const sum = /^calc\((-?[\d.]+)px ([+-]) (-?[\d.]+)px\)$/.exec(expanded);
      if (sum) {
        return Number(sum[1]) + (sum[2] === '+' ? 1 : -1) * Number(sum[3]);
      }
      throw new Error(`Unsupported geometry value ${expanded}`);
    };
    const horizontalPadding = ({ value }: { value: string }) => {
      const parts = value.split(/\s+/).map(Number.parseFloat);
      return { left: parts[3] ?? parts[1] ?? parts[0]!, right: parts[1] ?? parts[0]! };
    };
    for (const scene of [
      ...(['open', 'import', 'download', 'default'] as const).map(stage => ({ mode: 'llama' as const, stage, messages: llamaEnglish })),
      ...(['open', 'download', 'resume', 'save'] as const).map(stage => ({ mode: 'transformers' as const, stage, messages: transformersEnglish })),
    ]) {
      const html = await renderToString(createSSRApp({ render: () => h('article', { class: 'prose' }, [h(InBrowserModelSettingsStep, scene)]) }));
      using page = parsePage({ html });
      const element = ({ selector }: { selector: string }) => {
        const found = page.document.querySelector(selector);
        if (!found) {
          throw new Error(`Missing geometry element ${selector}`);
        }
        return found;
      };
      const styles = ({ selector }: { selector: string }) => declarations({ element: element({ selector }), stylesheet: css });
      const article = declarations({ element: element({ selector: '.prose' }), stylesheet: siteCss });
      const articlePadding = horizontalPadding({ value: required({ values: article, property: 'padding' }) });
      const root = styles({ selector: '.browser-model-camera' });
      const cameraBorder = Number.parseFloat(required({ values: root, property: 'border' }));
      const articleWidth = Math.min(viewportWidth, Number.parseFloat(required({ values: article, property: 'max-width' })));
      const cameraWidth = Math.min(articleWidth - articlePadding.left - articlePadding.right, Number.parseFloat(required({ values: root, property: 'max-width' }))) - 2 * cameraBorder;
      expect(required({ values: root, property: 'container-type' })).toBe('inline-size');
      const variables = new Map([...root, ...styles({ selector: '.camera-canvas' })]);
      const pixels = ({ values, property }: { values: Map<string, string>; property: string }) => length({ value: required({ values, property }), containerWidth: cameraWidth, variables });
      const rail = styles({ selector: '.app-sidebar' });
      const railWidth = length({ value: rail.get('flex-basis') ?? required({ values: rail, property: 'flex' }).split(/\s+/)[2]!, containerWidth: cameraWidth, variables });
      const workPadding = horizontalPadding({ value: required({ values: styles({ selector: '.work-area' }), property: 'padding' }) });
      const panel = styles({ selector: '.settings-panel' });
      const panelWidth = pixels({ values: panel, property: 'width' });
      const panelBorder = Number.parseFloat(required({ values: panel, property: 'border' }));
      const navigationWidth = Number.parseFloat(required({ values: panel, property: 'grid-template-columns' }));
      const stageLeft = railWidth + workPadding.left + panelBorder + navigationWidth;
      const stageWidth = panelWidth - 2 * panelBorder - navigationWidth;
      const bodyPadding = horizontalPadding({ value: required({ values: styles({ selector: '.stage-content' }), property: 'padding' }) });
      const stack = styles({ selector: '.compact-stack' });
      const bodyWidth = Math.min(stageWidth - bodyPadding.left - bodyPadding.right, stack.has('max-width') ? pixels({ values: stack, property: 'max-width' }) : Infinity);
      const bodyLeft = stageLeft + bodyPadding.left;
      const bodyRight = bodyLeft + bodyWidth;
      const visible = ({ left, right, phase }: { left: number; right: number; phase: 'start' | 'focus' | 'end' }) => {
        const offset = pixels({ values: variables, property: `--camera-${phase}-x` });
        const zoom = pixels({ values: variables, property: `--camera-${phase}-z` });
        expect(left * zoom + offset, `${scene.mode}/${scene.stage}/${phase} left`).toBeGreaterThanOrEqual(0);
        expect(right * zoom + offset, `${scene.mode}/${scene.stage}/${phase} right`).toBeLessThanOrEqual(cameraWidth);
      };
      for (const phase of ['start', 'focus', 'end'] as const) {
        if (scene.stage === 'open' && phase === 'start') {
          visible({ left: 0, right: railWidth, phase });
        } else if ((scene.stage === 'open' || scene.stage === 'save') && phase === 'focus') {
          visible({ left: railWidth + workPadding.left + panelBorder, right: stageLeft, phase });
        } else {
          // All localized labels, right-aligned actions, and completed rows live
          // within this body. Check both ends, not just a pointer's anchor.
          visible({ left: bodyLeft, right: bodyRight, phase });
        }
      }
      if (scene.stage === 'default') {
        const confirm = styles({ selector: '.confirm-panel' });
        const maxWidth = /^calc\(100% - (\d+)px\)$/.exec(required({ values: confirm, property: 'max-width' }));
        if (!maxWidth) {
          throw new Error('Missing confirmation panel width constraint');
        }
        const confirmLeft = stageLeft + pixels({ values: confirm, property: 'left' });
        const confirmWidth = Math.min(pixels({ values: confirm, property: 'width' }), stageWidth - Number(maxWidth[1]));
        visible({ left: confirmLeft, right: confirmLeft + confirmWidth, phase: 'focus' });
      }
      if (cameraWidth >= 672) {
        expect(panelWidth).toBe(805);
        expect(pixels({ values: variables, property: '--camera-end-x' })).toBe(scene.stage === 'open' ? -234 : -275);
      }
    }
  });

  it.each([
    { locale: 'en', s: transformersEnglish, common: commonEnglish },
    { locale: 'ja', s: transformersJapanese, common: commonJapanese },
  ] as const)('shows automatic post-download load and distinct later Load and Resume actions in $locale', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(TransformersGuide, { s, locale, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-models-transformers-js"]');
    const launch = article?.querySelector<HTMLAnchorElement>('a[data-docs-app-entry-path]');
    expect(launch?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/settings/transformers-js');
    expect(launch?.textContent).toBe('/#/settings/transformers-js');
    expect(launch?.querySelector('[data-docs-external-icon], .sr-only')).toBeNull();
    expect(article?.querySelector('.app-entry-onboarding')).toBeNull();
    expect(article?.querySelectorAll('section.walkthrough-step')).toHaveLength(4);
    for (const stage of ['open', 'download', 'resume', 'save']) {
      const scene = article?.querySelector(`[data-testid="transformers-settings-${stage}"]`);
      expect(scene?.getAttribute('data-docs-animation')).toBe(`transformers-settings-${stage}`);
      expect(scene?.querySelector('[data-docs-camera-canvas]')).not.toBeNull();
    }
    const download = article?.querySelector('[data-testid="transformers-settings-download"]');
    expect(download?.textContent).toContain(s.download_model);
    expect(download?.textContent).toContain(s.loading_from_local_storage);
    expect(download?.textContent).toContain(s.engine_ready);
    const later = article?.querySelector('[data-testid="transformers-settings-resume"]');
    expect(later?.textContent).toContain(s.load);
    expect(later?.textContent).toContain(s.resume);
    expect(later?.textContent).toContain(s.incomplete);
    const save = article?.querySelector('[data-testid="transformers-settings-save"]');
    expect(save?.querySelector('.manager-before-save')?.textContent).toContain(s.downloaded_models);
    expect([...save?.querySelectorAll('.connection-setup .connection-label') ?? []].map(label => label.textContent)).toEqual([s.connection, s.default_model]);
    expect(save?.querySelector('.connection-model-controls')?.textContent).toContain(s.manage_models);
    expect(save?.textContent).not.toContain(locale === 'en' ? 'API Provider' : 'API プロバイダー');
    expect(save?.textContent).not.toContain(locale === 'en' ? 'Endpoint Configuration' : 'エンドポイント設定');
    expect(save?.textContent).not.toContain('Endpoint URL');
    expect(article?.textContent).toContain(locale === 'en' ? 'Standalone' : 'スタンドアロン');
    expect(article?.textContent).toContain('OPFS');
    expect(article?.querySelector('.import-modes')).toBeNull();
    expect(article?.querySelector('button, input, select, script')).toBeNull();
  });

  it.each([
    { locale: 'en', s: overviewEnglish, common: commonEnglish },
    { locale: 'ja', s: overviewJapanese, common: commonJapanese },
  ] as const)('provides a direct GGUF start while keeping the other engines on their own guides in $locale', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(BrowserModelsGuide, { s, locale, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-models-in-browser"]');
    expect(article?.querySelector('.app-entry-intro a')?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/');
    expect([...article?.querySelectorAll('.card-guide-link') ?? []].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/endpoint-type-llama-cpp-browser/`,
      `/docs/${locale}/endpoint-type-transformers-js/`,
      `/docs/${locale}/endpoint-type-browser-provided-lm/`,
    ]);
    const steps = article?.querySelectorAll('.guide-steps > li');
    expect(steps).toHaveLength(4);
    expect(steps?.[0]?.querySelector('h3')?.textContent).toBe(s.select_llama_cpp_heading);
    expect(steps?.[1]?.textContent).toContain(locale === 'en' ? 'Run in your browser' : 'ブラウザ内で動かす');
    expect(steps?.[1]?.textContent).toContain('OPFS');
    expect([...article?.querySelectorAll('[data-docs-related-guide] a') ?? []].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/image-understanding/`,
      `/docs/${locale}/translation/`,
      `/docs/${locale}/live-conversation/`,
      `/docs/${locale}/local-ai-server/`,
    ]);
    expect(article?.querySelector('button, input, select, script')).toBeNull();
  });
});
