import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import InheritancePage from '../pages/settings/inheritance.vue';
import SettingsInheritanceStep from '../site/demos/SettingsInheritanceStep.vue';
import { strings as en } from '../strings/settings/inheritance/en';
import { strings as ja } from '../strings/settings/inheritance/ja';
import { strings as commonEn } from '../strings/common/en';
import { strings as commonJa } from '../strings/common/ja';
import { parsePage } from './site.test-support';
import { visibleGuideText } from './ui-label.test-support';

describe('settings inheritance guide', () => {
  it.each([
    { locale: 'en' as const, s: en, common: commonEn },
    { locale: 'ja' as const, s: ja, common: commonJa },
  ])('renders five localized explanation-and-screen pairs in %s', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(InheritancePage, { s, locale, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-settings-inheritance"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    const launch = article?.querySelector<HTMLAnchorElement>('[data-docs-app-entry-path]');
    expect(launch?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/');
    expect(launch?.textContent).toBe('/#/');
    const sections = [...(article?.querySelectorAll('section.walkthrough-step') ?? [])];
    expect(sections).toHaveLength(5);
    const stages = ['global', 'group', 'inheritedChat', 'chatModel', 'reset'] as const;
    for (const [index, stage] of stages.entries()) {
      const section = sections[index];
      expect(section?.querySelector('h2')?.textContent).toBe(s.steps[stage].title);
      expect(section?.querySelector('p')?.textContent).toBe(visibleGuideText({ text: s.steps[stage].body }));
      const scene = section?.querySelector(`[data-testid="inheritance-step-${stage}"]`);
      expect(scene?.getAttribute('data-docs-animation')).toBe(`inheritance-${stage}`);
      expect(scene?.querySelector('[data-testid="inheritance-camera-canvas"]')).not.toBeNull();
      expect(section?.querySelector('figcaption')?.textContent).toBe(visibleGuideText({ text: s.steps[stage].caption }));
    }
    expect(article?.querySelector('[data-docs-related-guide] a')?.getAttribute('href')).toBe(`/docs/${locale}/models/ollama/`);
    expect(article?.querySelectorAll('script, [data-docs-island]')).toHaveLength(0);
  });

  it.each([
    { locale: 'en', s: en },
    { locale: 'ja', s: ja },
  ])('shows the parent source and separate endpoint/model override controls in %s', async ({ s }) => {
    const html = await renderToString(createSSRApp({ render: () => h(SettingsInheritanceStep, { stage: 'inheritedChat', copy: s.demo }) }));
    using page = parsePage({ html });
    const scene = page.document.querySelector('[data-testid="inheritance-step-inheritedChat"]');
    expect(scene?.textContent).toContain(s.demo.groupOllama);
    expect(scene?.textContent).toContain(s.demo.groupUrl);
    expect(scene?.textContent).toContain(s.demo.groupModelValue);
    expect(scene?.textContent).toContain(s.demo.endpointType);
    expect(scene?.textContent).toContain(s.demo.chatModel);
    expect(scene?.textContent).not.toContain(s.demo.globalModel);
    expect(scene?.querySelector('[data-testid="inheritance-chat-modal"]')).not.toBeNull();
    expect(scene?.querySelector('.chat-page-header .model-trigger')?.textContent).toContain(s.demo.groupValue);
    expect(scene?.querySelector('button, input, select, script')).toBeNull();
  });

  it('uses the actual global modal, group page, and chat header entry points', async () => {
    for (const [stage, expected] of [
      ['global', '.sidebar-settings, .global-modal'],
      ['group', '.sidebar-tree .group-item, .group-page'],
      ['inheritedChat', '.chat-page-header .model-trigger, .chat-modal'],
    ] as const) {
      const html = await renderToString(createSSRApp({ render: () => h(SettingsInheritanceStep, { stage, copy: en.demo }) }));
      using page = parsePage({ html });
      const scene = page.document.querySelector(`[data-testid="inheritance-step-${stage}"]`);
      for (const selector of expected.split(', ')) expect(scene?.querySelector(selector)).not.toBeNull();
    }
  });

  it('continues from the prior chat model, changes endpoint and model, then restores the group values', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(SettingsInheritanceStep, { stage: 'reset', copy: en.demo }) }));
    using page = parsePage({ html });
    const scene = page.document.querySelector('[data-testid="inheritance-step-reset"]');
    expect(scene?.textContent).toContain(en.demo.openai);
    expect(scene?.textContent).toContain('http://localhost:1234/v1');
    expect(scene?.textContent).toContain(en.demo.otherValue);
    expect(scene?.textContent).toContain(en.demo.groupOllama);
    expect(scene?.textContent).toContain(en.demo.groupUrl);
    expect(scene?.textContent).toContain(en.demo.groupModelValue);
    const header = scene?.querySelector('.chat-page-header .model-trigger');
    expect(header?.querySelector('.reset-initial')?.textContent).toBe(en.demo.chatValue);
    expect(header?.querySelector('.reset-cleared')?.textContent).toBe(en.demo.groupValue);
    expect(header?.querySelector('.reset-local-model')?.textContent).toBe(en.demo.otherValue);
    expect(header?.querySelector('.reset-final')?.textContent).toBe(en.demo.groupValue);
    expect(scene?.querySelector('.endpoint-control .reset-initial')?.textContent).toBe(en.demo.groupOllama);
    expect(scene?.querySelector('.endpoint-control .reset-local-endpoint')?.textContent).toBe(en.demo.openai);
    expect(scene?.querySelector('.endpoint-control .reset-final')?.textContent).toBe(en.demo.groupOllama);
    expect(scene?.querySelector('.model-control .reset-initial')?.textContent).toBe(en.demo.chatValue);
    expect(scene?.querySelector('.model-control .reset-local-model')?.textContent).toBe(en.demo.otherValue);
    expect(scene?.querySelector('.model-control .reset-final')?.textContent).toBe(en.demo.groupModelValue);
    expect(scene?.querySelector('button, input, select, script')).toBeNull();
  });

  it('updates the chat header label with the selected model', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(SettingsInheritanceStep, { stage: 'chatModel', copy: en.demo }) }));
    using page = parsePage({ html });
    const header = page.document.querySelector('[data-testid="inheritance-step-chatModel"] .chat-page-header .model-trigger');
    expect(header?.querySelector('.phase-start')?.textContent).toBe(en.demo.groupValue);
    expect(header?.querySelector('.phase-end')?.textContent).toBe(en.demo.chatValue);
  });
});
