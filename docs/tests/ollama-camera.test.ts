import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import OllamaGuide from '../pages/endpoint-type-ollama/index.vue';
import { messages as english } from '../pages/endpoint-type-ollama/messages/en';
import { messages as japanese } from '../pages/endpoint-type-ollama/messages/ja';
import { parsePage } from './site.test-support';
import { messages as commonEn } from '../messages/common/en';
import { messages as commonJa } from '../messages/common/ja';

describe('Ollama camera guide', () => {
  it.each(['en', 'ja'] as const)('keeps one settings screen and the completed choices through the %s steps', async locale => {
    const copy = locale === 'en' ? english : japanese;
    const html = await renderToString(createSSRApp({
      render: () => h(OllamaGuide, {
        s: copy,
        locale,
        common: locale === 'en' ? commonEn : commonJa,
      }),
    }));
    using page = parsePage({ html });
    const launch = page.document.querySelector<HTMLAnchorElement>('[data-docs-app-entry-path]');
    expect(launch?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/settings/connection');
    expect(launch?.textContent).toBe('/#/settings/connection');
    const sections = [...page.document.querySelectorAll('article section.walkthrough-step')];
    expect(sections.map(section => section.querySelector('[data-docs-animation]')?.getAttribute('data-docs-animation'))).toEqual([
      'ollama-open', 'ollama-provider', 'ollama-check', 'ollama-model',
    ]);

    for (const section of sections) {
      expect(section.children[0]?.tagName).toBe('H2');
      expect(section.children[1]?.tagName).toBe('P');
      expect(section.children[2]?.tagName).toBe('FIGURE');
      expect(section.querySelector('figcaption')?.textContent?.trim()).toBeTruthy();
      const scene = section.querySelector('[data-docs-animation]');
      expect(scene?.querySelector('.camera-canvas .settings-modal .modal-tabs')).not.toBeNull();
      expect(scene?.querySelector('.connection-layout > .provider-field .field-box')).not.toBeNull();
      expect(scene?.querySelector('.connection-details .url-box')).not.toBeNull();
      expect(scene?.querySelector('.connection-layout > .model-section .model-box')).not.toBeNull();
      expect(scene?.querySelector('.modal-footer .save-action')).not.toBeNull();
    }

    const provider = sections[1]?.querySelector('[data-docs-animation]');
    const check = sections[2]?.querySelector('[data-docs-animation]');
    const model = sections[3]?.querySelector('[data-docs-animation]');
    expect(provider?.querySelector('.provider-options')?.textContent).toContain(copy.ollama);
    expect(provider?.querySelector('.url-box')?.textContent).toContain('http://localhost:11434');
    expect(check?.querySelector('.check-done')?.textContent).toContain(copy.check_connection);
    expect(model?.querySelector('.model-box')?.textContent).toContain(copy.sample_ollama_model);
    expect(model?.querySelector('.save-action')?.textContent).toContain(copy.settings_saved);
  });
});
