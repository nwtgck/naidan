import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { compileStyle, parse as parseSfc } from '@vue/compiler-sfc';
import { list, parse as parseCss } from 'postcss';
import { JSDOM } from 'jsdom';
import Page from '../pages/live-conversation/index.vue';
import { messages as en } from '../pages/live-conversation/messages/en';
import { messages as ja } from '../pages/live-conversation/messages/ja';
import { messages as commonEn } from '../messages/common/en';
import { messages as commonJa } from '../messages/common/ja';

const locales = [{ locale: 'en', s: en, common: commonEn }, { locale: 'ja', s: ja, common: commonJa }] as const;

function parseDocument({ html }: { html: string }) {
  const window = new JSDOM(html).window;
  return { window, document: window.document, [Symbol.dispose]: () => window.close() };
}

describe('live conversation guide', () => {
  it.each(locales)('renders the complete $locale workflow without activating media or app controls', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp(Page, { s, locale, common }));
    using page = parseDocument({ html });
    const { document } = page;
    expect(document.querySelector('h1')?.textContent).toBe(s.title);
    expect(document.querySelector('.app-entry-intro a')?.getAttribute('data-docs-app-entry-path')).toBe('/#/live-conversation');
    expect([...document.querySelectorAll('section h2')].map(heading => heading.textContent)).toEqual([
      s.prepare_heading, s.talk_heading, s.interrupt_heading, s.other_inputs_heading, s.shell_heading, s.memory_heading,
    ]);
    expect([...document.querySelectorAll('[data-docs-animation]')].map(demo => demo.getAttribute('data-docs-animation'))).toEqual([
      'live-prepare', 'live-talk', 'live-interrupt', 'live-attachments', 'live-shell',
    ]);
    expect(document.querySelector('#live-prepare')?.parentElement?.textContent).toContain('LFM3-Omni-2B');
    expect(document.querySelector('#live-prepare')?.parentElement?.textContent).toContain('WebGPU JSPI');
    expect(document.querySelector('#live-shell')?.parentElement?.textContent).toContain('/workspace');
    expect(document.querySelector('#live-shell')?.parentElement?.textContent).toContain('sysfs');
    expect(document.querySelector('#live-memory')?.parentElement?.textContent).toMatch(locale === 'en' ? /not saved as an ordinary chat/ : /通常のチャットとしては保存されません/);
    expect(document.querySelector('#live-memory')?.parentElement?.textContent).toMatch(locale === 'en' ? /initially off/ : /初期状態で無効/);
    expect(document.querySelector('[data-testid="live-command-approval"] pre')?.textContent).toBe('cat /workspace/ingredients.txt');
    const turn = document.querySelector('[data-testid="live-step-talk"] [data-testid="live-example-turn"]');
    expect(turn?.querySelector('.user-message')?.textContent).toContain(s.sample_question);
    expect(turn?.querySelector('.answer')?.textContent).toBe(s.sample_answer);
    expect(document.querySelector('[data-testid="live-step-talk"] .status-playing')?.textContent).toBe(s.playing_response);
    expect(document.querySelector('[data-testid="live-step-interrupt"] .discarded')?.textContent).toBe(s.discarded);
    expect(document.querySelector('[data-testid="live-step-attachments"] .audio-attachment')?.textContent).toContain(s.sample_audio_file);
    expect(document.querySelectorAll('figure button, figure input, figure textarea, figure audio, figure video, figure a, figure [tabindex]')).toHaveLength(0);
    expect(document.querySelectorAll('script, iframe')).toHaveLength(0);
    expect([...document.querySelectorAll('[data-docs-related-guide] a')].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/endpoint-type-llama-cpp-browser/`, `/docs/${locale}/file-and-folder-settings/`, `/docs/${locale}/audio-generation/`,
    ]);
  });

  it.each(locales.flatMap(item => ['pause', 'reduced'].map(mode => ({ ...item, mode }))))('keeps $locale messages and discarded turns readable when motion is $mode', async ({ s, locale, common, mode }) => {
    const html = await renderToString(createSSRApp(Page, { s, locale, common }));
    const source = await readFile(new URL('../components/demos/LiveConversationGuideStep.vue', import.meta.url), 'utf8');
    const { descriptor } = parseSfc(source);
    const scope = 'data-v-live-motion-test';
    const compiled = compileStyle({ source: descriptor.styles.map(style => style.content).join('\n'), filename: 'LiveConversationGuideStep.vue', id: scope, scoped: true });
    expect(compiled.errors).toEqual([]);
    const reducedRules: string[] = [];
    parseCss(compiled.code).walkAtRules('media', rule => {
      if (rule.params.includes('prefers-reduced-motion')) {
        reducedRules.push(...(rule.nodes?.map(node => node.toString()) ?? []));
      }
    });
    using page = parseDocument({ html: `<!doctype html><html><head></head><body><input id="docs-pause-motion" type="checkbox">${html}</body></html>` });
    const { document, window } = page;
    document.querySelectorAll('.live-camera, .live-camera *').forEach(element => element.setAttribute(scope, ''));
    const sheet = document.createElement('style');
    sheet.textContent = compiled.code + (mode === 'reduced' ? `\n${reducedRules.join('\n')}` : '');
    document.head.append(sheet);
    if (mode === 'pause') {
      const control = document.querySelector<HTMLInputElement>('#docs-pause-motion');
      if (!control) {
        throw new Error('Missing motion control');
      }
      control.checked = true;
    }
    const styleOf = ({ selector }: { selector: string }) => {
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error(`Missing live conversation element: ${selector}`);
      }
      return window.getComputedStyle(element);
    };
    for (const selector of ['.stage-talk .reply-character', '.stage-interrupt .discarded', '.stage-interrupt .replacement-message', '.stage-attachments .audio-attachment', '.stage-interrupt [data-testid="live-send-control"]', '.stage-attachments [data-testid="live-send-control"]']) {
      expect(styleOf({ selector }).animation, selector).toBe('none');
      expect(styleOf({ selector }).opacity, selector).toBe('1');
    }
    for (const selector of ['.start-pointer', '.record-pointer', '.interrupt-pointer', '.attachment-menu', '.audio-pointer', '.approve-pointer', '.stage-interrupt .placeholder']) {
      expect(styleOf({ selector }).opacity, selector).toBe('0');
    }
    expect(styleOf({ selector: '.stage-interrupt .turn' }).opacity).toBe('0.6');
    expect(styleOf({ selector: '.stage-talk [data-testid="live-send-control"]' }).opacity).toBe('0.4');
    expect(styleOf({ selector: '.stage-talk .record-control' }).opacity).not.toBe('0.4');
    expect(styleOf({ selector: '.stage-attachments .record-control' }).opacity).toBe('0.4');
    expect(styleOf({ selector: '.stage-shell .live-canvas' }).transform).toBe('translate(-50%,-290px)');
    expect(styleOf({ selector: '.live-camera' }).height).toBe('454px');
  });

  it.each(locales)('preserves the $locale narrow focus and scoped theme changes with motion paused', async ({ s, locale, common }) => {
    const html = await renderToString(createSSRApp(Page, { s, locale, common }));
    const source = await readFile(new URL('../components/demos/LiveConversationGuideStep.vue', import.meta.url), 'utf8');
    const { descriptor } = parseSfc(source);
    const scope = 'data-v-live-narrow-test';
    const compiled = compileStyle({ source: descriptor.styles.map(style => style.content).join('\n'), filename: 'LiveConversationGuideStep.vue', id: scope, scoped: true });
    expect(compiled.errors).toEqual([]);
    const themeSelectors: string[] = [];
    parseCss(compiled.code).walkRules(rule => {
      themeSelectors.push(...list.comma(rule.selector).filter(selector => selector.includes('data-theme') || selector.includes('#docs-light-theme')));
    });
    expect(themeSelectors).toEqual(expect.arrayContaining([
      `html[data-theme='light'] .live-camera[${scope}]`,
      `html:has(#docs-light-theme:checked) .live-camera[${scope}]`,
      `html[data-theme='light'] .discarded[${scope}]`,
      `html:has(#docs-light-theme:checked) .discarded[${scope}]`,
    ]));
    const narrowRules: string[] = [];
    parseCss(compiled.code).walkAtRules('media', rule => {
      if (rule.params.includes('max-width:560px')) {
        narrowRules.push(...(rule.nodes?.map(node => node.toString()) ?? []));
      }
    });
    using page = parseDocument({ html: `<!doctype html><html><head></head><body><input id="docs-light-theme" type="checkbox"><input id="docs-pause-motion" type="checkbox">${html}</body></html>` });
    const { document, window } = page;
    document.querySelectorAll('.live-camera, .live-camera *').forEach(element => element.setAttribute(scope, ''));
    const sheet = document.createElement('style');
    sheet.textContent = `${compiled.code}\n${narrowRules.join('\n')}`;
    document.head.append(sheet);
    const camera = document.querySelector('.live-camera');
    const canvas = document.querySelector('.live-canvas');
    const lightControl = document.querySelector<HTMLInputElement>('#docs-light-theme');
    const pauseControl = document.querySelector<HTMLInputElement>('#docs-pause-motion');
    const discarded = document.querySelector('.stage-interrupt .discarded');
    if (!camera || !canvas || !lightControl || !pauseControl || !discarded) {
      throw new Error('Missing narrow demo or theme control');
    }
    expect(window.getComputedStyle(camera).height).toBe('466px');
    expect(window.getComputedStyle(camera).getPropertyValue('--focus-width')).toBe('276px');
    expect(window.getComputedStyle(canvas).left).toBe('50%');
    expect(window.getComputedStyle(canvas).transform).not.toContain('scale');
    const darkSurface = window.getComputedStyle(camera).getPropertyValue('--app-bg');
    const darkMarker = window.getComputedStyle(discarded).color;
    pauseControl.checked = true;
    lightControl.checked = true;
    const lightSurface = window.getComputedStyle(camera).getPropertyValue('--app-bg');
    const lightMarker = window.getComputedStyle(discarded).color;
    expect(darkSurface).not.toBe(lightSurface);
    expect(darkMarker).not.toBe(lightMarker);
    expect(window.getComputedStyle(discarded).opacity).toBe('1');
    lightControl.checked = false;
    document.documentElement.dataset.theme = 'light';
    expect(window.getComputedStyle(camera).getPropertyValue('--app-bg')).toBe(lightSurface);
    expect(window.getComputedStyle(discarded).color).toBe(lightMarker);
    expect(window.getComputedStyle(discarded).opacity).toBe('1');
    expect(window.getComputedStyle(document.documentElement).getPropertyValue('--app-bg')).toBe('');
    expect(window.getComputedStyle(document.documentElement).color).not.toBe(lightMarker);
    document.documentElement.dataset.theme = 'dark';
    expect(window.getComputedStyle(camera).getPropertyValue('--app-bg')).toBe(darkSurface);
    expect(window.getComputedStyle(discarded).color).toBe(darkMarker);
  });
});
