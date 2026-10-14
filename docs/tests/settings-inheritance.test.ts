import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { compileStyle, parse } from '@vue/compiler-sfc';
import InheritancePage from '../pages/settings/inheritance.vue';
import SettingsInheritanceDiagram from '../site/demos/SettingsInheritanceDiagram.vue';
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
  ])('explains the value and model choice before five localized screen steps in %s', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(InheritancePage, { s, locale, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-settings-inheritance"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect([...(article?.querySelectorAll('h2') ?? [])].slice(0, 3).map(heading => heading.textContent)).toEqual([
      s.why.title, s.concept.title, s.setupTitle,
    ]);
    expect(article?.querySelector('.guide-purpose p')?.textContent).toBe(visibleGuideText({ text: s.why.body }));
    expect(article?.querySelector('.guide-concept p')?.textContent).toBe(visibleGuideText({ text: s.concept.definition }));
    const diagram = article?.querySelector('[data-testid="inheritance-concept"]');
    expect(diagram?.getAttribute('data-docs-animation')).toBe('inheritance-concept');
    expect(diagram?.querySelectorAll('.phase')).toHaveLength(4);
    expect(article?.querySelector('.guide-concept figcaption')?.textContent).toBe(visibleGuideText({ text: s.concept.caption }));
    const launch = article?.querySelector<HTMLAnchorElement>('[data-docs-app-entry-path]');
    expect(launch?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/');
    expect(launch?.textContent).toBe('Naidan');
    const sections = [...(article?.querySelectorAll('section.walkthrough-step') ?? [])];
    expect(sections).toHaveLength(5);
    const stages = ['global', 'group', 'inheritedChat', 'chatModel', 'reset'] as const;
    for (const [index, stage] of stages.entries()) {
      const section = sections[index];
      expect(section?.querySelector('h3')?.textContent).toBe(s.steps[stage].title);
      expect(section?.querySelector('p:not(.group-preparation)')?.textContent).toBe(visibleGuideText({ text: s.steps[stage].body }));
      const scene = section?.querySelector(`[data-testid="inheritance-step-${stage}"]`);
      expect(scene?.getAttribute('data-docs-animation')).toBe(`inheritance-${stage}`);
      expect(scene?.querySelector('[data-testid="inheritance-camera-canvas"]')).not.toBeNull();
      expect(section?.querySelector('figcaption')?.textContent).toBe(visibleGuideText({ text: s.steps[stage].caption }));
    }
    const groupPreparation = sections[1]?.querySelector('.group-preparation');
    expect(groupPreparation?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/chat/groups/`);
    expect(groupPreparation?.textContent).toBe(`${s.groupPreparation.before}${s.groupsLink}${s.groupPreparation.after}`);
    expect(sections[0]?.querySelector('.group-preparation')).toBeNull();
    expect([...(article?.querySelectorAll('[data-docs-related-guide] a') ?? [])].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/chat/groups/`, `/docs/${locale}/models/ollama/`,
    ]);
    expect(article?.querySelectorAll('script, [data-docs-island]')).toHaveLength(0);
  });

  it.each([
    { locale: 'en', copy: en.concept.diagram },
    { locale: 'ja', copy: ja.concept.diagram },
  ])('uses the same question and stops at the first model setting in %s', async ({ copy }) => {
    const html = await renderToString(createSSRApp({ render: () => h(SettingsInheritanceDiagram, { copy }) }));
    using page = parsePage({ html });
    const diagram = page.document.querySelector('[data-testid="inheritance-concept"]');
    const phase = (id: keyof typeof copy.phases) => diagram?.querySelector(`[data-testid="inheritance-concept-${id}"]`);
    const scope = (id: keyof typeof copy.phases, slot: keyof typeof copy.scopes) => phase(id)?.querySelector(`[data-testid="inheritance-scope-${id}-${slot}"]`);
    const result = (id: keyof typeof copy.phases) => phase(id)?.querySelector(`[data-testid="inheritance-result-${id}"]`);
    expect([...(diagram?.querySelectorAll('.phase') ?? [])].map(scene => scene.querySelector('.phase-title')?.textContent)).toEqual([
      copy.phases.ungrouped, copy.phases.groupUnset, copy.phases.groupModel, copy.phases.chatModel,
    ]);
    for (const scene of diagram?.querySelectorAll('.phase') ?? []) {
      expect(scene.querySelector('.question-card')?.textContent).toContain(copy.question);
      expect(scene.querySelector('.example-answer')?.textContent).toContain(copy.answerLabel);
    }
    expect(scope('ungrouped', 'group')?.getAttribute('data-checked')).toBe('false');
    expect(scope('ungrouped', 'group')?.textContent).toContain(copy.states.outside);
    expect(scope('ungrouped', 'global')?.getAttribute('data-selected')).toBe('true');
    expect(scope('groupUnset', 'group')?.getAttribute('data-checked')).toBe('true');
    expect(scope('groupUnset', 'group')?.textContent).toContain(copy.states.unset);
    expect(scope('groupUnset', 'global')?.getAttribute('data-selected')).toBe('true');
    expect(result('ungrouped')?.textContent).toContain(copy.models.global);
    expect(result('groupUnset')?.textContent).toContain(copy.models.global);
    expect(result('groupUnset')?.textContent).toContain(copy.sources.global);
    expect(result('ungrouped')?.textContent).toContain(copy.answers.park.join(''));
    expect(result('groupUnset')?.textContent).toContain(copy.answers.park.join(''));
    expect(scope('groupModel', 'group')?.getAttribute('data-selected')).toBe('true');
    expect(scope('groupModel', 'global')?.getAttribute('data-checked')).toBe('false');
    expect(result('groupModel')?.textContent).toContain(copy.models.group);
    expect(result('groupModel')?.textContent).toContain(copy.answers.movie.join(''));
    expect(scope('chatModel', 'chat')?.getAttribute('data-selected')).toBe('true');
    expect(scope('chatModel', 'group')?.getAttribute('data-checked')).toBe('false');
    expect(scope('chatModel', 'global')?.getAttribute('data-checked')).toBe('false');
    expect(result('chatModel')?.textContent).toContain(copy.models.chat);
    expect(result('chatModel')?.textContent).toContain(copy.answers.museum.join(''));
    expect(diagram?.querySelector('button, input, select, script')).toBeNull();
  });

  it.each([
    { file: '../site/demos/SettingsInheritanceDiagram.vue', completed: '.inheritance-diagram .phase-chatModel' },
    { file: '../site/demos/SettingsInheritanceStep.vue', completed: '.stage-reset .scene-canvas' },
  ])('keeps pause rules attached to the completed $file scene after scoped CSS compilation', ({ file, completed }) => {
    const filename = new URL(file, import.meta.url);
    const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname });
    expect(errors).toHaveLength(0);
    const style = descriptor.styles[0];
    if (!style) throw new Error(`Missing style block in ${file}`);
    const compiled = compileStyle({ source: style.content, filename: filename.pathname, id: 'data-v-test', scoped: true });
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.code).toContain(`html:has(#docs-pause-motion:checked) ${completed}`);
    expect(compiled.code).not.toMatch(/html:has\(#docs-pause-motion:checked\)\s*\{/);
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
