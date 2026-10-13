import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import OllamaGuide from '../pages/models/ollama.vue';
import { strings as english } from '../strings/models/ollama/en';
import { strings as japanese } from '../strings/models/ollama/ja';
import { parsePage } from './site.test-support';
import type { CommonMessages } from '../site/messages';

describe('Ollama camera guide', () => {
  it.each(['en', 'ja'] as const)('keeps one settings screen and the completed choices through the %s steps', async locale => {
    const copy = locale === 'en' ? english : japanese;
    const html = await renderToString(createSSRApp({
      render: () => h(OllamaGuide, {
        s: copy,
        locale,
        common: {} as CommonMessages,
      }),
    }));
    using page = parsePage({ html });
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
      expect(scene?.querySelector('.camera-canvas .settings-modal .modal-rail')).not.toBeNull();
      expect(scene?.querySelector('.endpoint-section .provider-control')).not.toBeNull();
      expect(scene?.querySelector('.endpoint-section .url-control')).not.toBeNull();
      expect(scene?.querySelector('.model-section .model-control')).not.toBeNull();
      expect(scene?.querySelector('.modal-footer .save-button')).not.toBeNull();
    }

    const provider = sections[1]?.querySelector('[data-docs-animation]');
    const check = sections[2]?.querySelector('[data-docs-animation]');
    const model = sections[3]?.querySelector('[data-docs-animation]');
    expect(provider?.querySelector('.provider-menu')?.textContent).toContain(copy.demo.ollama);
    expect(provider?.querySelector('.url-control')?.textContent).toContain('http://localhost:11434');
    expect(check?.querySelector('.check-control')?.textContent).toContain(copy.demo.connected);
    expect(model?.querySelector('.model-control')?.textContent).toContain(copy.demo.exampleModel);
    expect(model?.querySelector('.save-button')?.textContent).toContain(copy.demo.settingsSaved);
  });
});
