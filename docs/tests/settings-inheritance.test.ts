import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSSRApp, h } from 'vue';
import type { VNode } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { compileStyle, parse } from '@vue/compiler-sfc';
import postcss from 'postcss';
import InheritancePage from '../pages/settings-inheritance/index.vue';
import SettingsInheritanceDiagram from '../components/demos/SettingsInheritanceDiagram.vue';
import SettingsInheritanceStep from '../components/demos/SettingsInheritanceStep.vue';
import { messages as en } from '../pages/settings-inheritance/messages/en';
import { messages as ja } from '../pages/settings-inheritance/messages/ja';
import { messages as commonEn } from '../messages/common/en';
import { messages as commonJa } from '../messages/common/ja';
import { parsePage } from './site.test-support';

async function renderedText({ node }: { node: VNode }) {
  const html = await renderToString(createSSRApp({ render: () => node }));
  using page = parsePage({ html });
  return page.document.body.textContent;
}

describe('settings inheritance guide', () => {
  it.each([
    { locale: 'en' as const, s: en, common: commonEn },
    { locale: 'ja' as const, s: ja, common: commonJa },
  ])('explains the value and model choice before five localized screen steps in $locale', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(InheritancePage, { s, locale, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-settings-inheritance"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect([...(article?.querySelectorAll('h2') ?? [])].slice(0, 3).map(heading => heading.textContent)).toEqual([
      s.why_set_a_group_model_heading, s.which_model_answers_heading, s.set_values_in_naidan_heading,
    ]);
    expect(article?.querySelector('.guide-purpose p')?.textContent).toBe(s.why_set_a_group_model);
    expect(article?.querySelector('.guide-concept p')?.textContent).toBe(s.how_model_inheritance_works);
    const diagram = article?.querySelector('[data-testid="inheritance-concept"]');
    expect(diagram?.getAttribute('data-docs-animation')).toBe('inheritance-concept');
    expect(diagram?.querySelectorAll('.phase')).toHaveLength(4);
    expect(article?.querySelector('.guide-concept figcaption')?.textContent).toBe(s.model_choice_diagram_caption);
    const launch = article?.querySelector<HTMLAnchorElement>('[data-docs-app-entry-path]');
    expect(launch?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/settings/connection');
    expect(launch?.textContent).toBe('/#/settings/connection');
    const sections = [...(article?.querySelectorAll('section.walkthrough-step') ?? [])];
    expect(sections).toHaveLength(5);
    const steps = [
      { stage: 'global', title: s.set_global_starting_point_heading, body: s.set_global_starting_point_instructions, caption: s.global_connection_caption },
      { stage: 'group', title: s.set_group_model_and_endpoint_heading, body: s.set_group_model_and_endpoint_instructions, caption: s.group_endpoint_caption },
      { stage: 'inheritedChat', title: s.read_inherited_chat_values_heading, body: s.read_inherited_chat_values_instructions, caption: s.inherited_chat_values_caption },
      { stage: 'chatModel', title: s.change_one_chat_model_heading, body: s.change_one_chat_model_instructions, caption: s.chat_model_override_caption },
      { stage: 'reset', title: s.change_endpoint_then_inherit_heading, body: s.change_endpoint_then_inherit_instructions, caption: s.return_to_inherited_endpoint_caption },
    ] as const;
    for (const [index, step] of steps.entries()) {
      const section = sections[index];
      expect(section?.querySelector('h3')?.textContent).toBe(step.title);
      expect(section?.querySelector('p:not(.group-preparation)')?.textContent).toBe(await renderedText({ node: step.body() }));
      const scene = section?.querySelector(`[data-testid="inheritance-step-${step.stage}"]`);
      expect(scene?.getAttribute('data-docs-animation')).toBe(`inheritance-${step.stage}`);
      expect(scene?.querySelector('[data-testid="inheritance-camera-canvas"]')).not.toBeNull();
      expect(section?.querySelector('figcaption')?.textContent).toBe(typeof step.caption === 'string' ? step.caption : await renderedText({ node: step.caption() }));
    }
    const groupPreparation = sections[1]?.querySelector('.group-preparation');
    expect(groupPreparation?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/chat-groups/`);
    expect(groupPreparation?.textContent).toBe(await renderedText({ node: s.prepare_a_chat_group({ locale }) }));
    expect(sections[0]?.querySelector('.group-preparation')).toBeNull();
    expect([...(article?.querySelectorAll('[data-docs-related-guide] a') ?? [])].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/chat-groups/`, `/docs/${locale}/endpoint-type-ollama/`,
    ]);
    expect(article?.querySelectorAll('script, [data-docs-island]')).toHaveLength(0);
  });

  it.each([
    { locale: 'en', messages: en },
    { locale: 'ja', messages: ja },
  ])('uses the same question and stops at the first model setting in %s', async ({ messages }) => {
    const html = await renderToString(createSSRApp({ render: () => h(SettingsInheritanceDiagram, { messages }) }));
    using page = parsePage({ html });
    const diagram = page.document.querySelector('[data-testid="inheritance-concept"]');
    type Phase = 'ungrouped' | 'groupUnset' | 'groupModel' | 'chatModel';
    const phase = (id: Phase) => diagram?.querySelector(`[data-testid="inheritance-concept-${id}"]`);
    const scope = (id: Phase, slot: 'chat' | 'group' | 'global') => phase(id)?.querySelector(`[data-testid="inheritance-scope-${id}-${slot}"]`);
    const result = (id: Phase) => phase(id)?.querySelector(`[data-testid="inheritance-result-${id}"]`);
    expect([...(diagram?.querySelectorAll('.phase') ?? [])].map(scene => scene.querySelector('.phase-title')?.textContent)).toEqual([
      messages.ungrouped_model_choice_heading, messages.unset_group_model_choice_heading, messages.group_model_choice_heading, messages.chat_model_choice_heading,
    ]);
    for (const scene of diagram?.querySelectorAll('.phase') ?? []) {
      expect(scene.querySelector('.question-card')?.textContent).toContain(messages.suggest_one_thing_to_do_this_weekend);
      expect(scene.querySelector('.example-answer')?.textContent).toContain(messages.example_reply);
    }
    expect(scope('ungrouped', 'group')?.getAttribute('data-checked')).toBe('false');
    expect(scope('ungrouped', 'group')?.textContent).toContain(messages.no_group);
    expect(scope('ungrouped', 'global')?.getAttribute('data-selected')).toBe('true');
    expect(scope('groupUnset', 'group')?.getAttribute('data-checked')).toBe('true');
    expect(scope('groupUnset', 'group')?.textContent).toContain(messages.no_model_set);
    expect(scope('groupUnset', 'global')?.getAttribute('data-selected')).toBe('true');
    expect(result('ungrouped')?.textContent).toContain(messages.global_example_model);
    expect(result('groupUnset')?.textContent).toContain(messages.global_example_model);
    expect(result('groupUnset')?.textContent).toContain(messages.from_global);
    expect(result('ungrouped')?.textContent).toContain(messages.answers_park().join(''));
    expect(result('groupUnset')?.textContent).toContain(messages.answers_park().join(''));
    expect(scope('groupModel', 'group')?.getAttribute('data-selected')).toBe('true');
    expect(scope('groupModel', 'global')?.getAttribute('data-checked')).toBe('false');
    expect(result('groupModel')?.textContent).toContain(messages.group_example_model);
    expect(result('groupModel')?.textContent).toContain(messages.answers_movie().join(''));
    expect(scope('chatModel', 'chat')?.getAttribute('data-selected')).toBe('true');
    expect(scope('chatModel', 'group')?.getAttribute('data-checked')).toBe('false');
    expect(scope('chatModel', 'global')?.getAttribute('data-checked')).toBe('false');
    expect(result('chatModel')?.textContent).toContain(messages.chat_example_model);
    expect(result('chatModel')?.textContent).toContain(messages.answers_museum().join(''));
    expect(diagram?.querySelector('button, input, select, script')).toBeNull();
  });

  it.each([
    { file: '../components/demos/SettingsInheritanceDiagram.vue', completed: '.inheritance-diagram .phase-chatModel' },
    { file: '../components/demos/SettingsInheritanceStep.vue', completed: '.stage-reset .scene-canvas' },
  ])('keeps pause rules attached to the completed $file scene after scoped CSS compilation', ({ file, completed }) => {
    const filename = new URL(file, import.meta.url);
    const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname });
    expect(errors).toHaveLength(0);
    const style = descriptor.styles[0];
    if (!style) {
      throw new Error(`Missing style block in ${file}`);
    }
    const compiled = compileStyle({ source: style.content, filename: filename.pathname, id: 'data-v-test', scoped: true });
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.code).toContain(`html:has(#docs-pause-motion:checked) ${completed}`);
    expect(compiled.code).not.toMatch(/html:has\(#docs-pause-motion:checked\)\s*\{/);
  });

  it.each([
    { locale: 'en', s: en },
    { locale: 'ja', s: ja },
  ])('shows the parent source and separate endpoint/model override controls in %s', async ({ s }) => {
    const html = await renderToString(createSSRApp({ render: () => h(SettingsInheritanceStep, { stage: 'inheritedChat', messages: s }) }));
    using page = parsePage({ html });
    const scene = page.document.querySelector('[data-testid="inheritance-step-inheritedChat"]');
    expect(scene?.textContent).toContain(s.chat_group_ollama);
    expect(scene?.querySelector('.connection-summary .source-badge')?.textContent).toBe(s.source_chat_group);
    expect(scene?.querySelector('.model-control .source-badge')?.textContent).toBe(s.source_chat_group);
    expect(scene?.querySelector('[data-testid="inheritance-effective-url"]')?.textContent).toBe('http://localhost:11434');
    expect(scene?.querySelector('[data-testid="inheritance-connection-details"]')).not.toBeNull();
    expect(scene?.querySelector('.model-control')?.textContent).toContain(s.group_example_model_id);
    expect(scene?.textContent).toContain(s.endpoint_type);
    expect(scene?.textContent).toContain(s.model_override);
    expect(scene?.textContent).not.toContain(s.global_gemma3n_e2b);
    expect(scene?.querySelector('[data-testid="inheritance-chat-modal"]')).not.toBeNull();
    expect(scene?.querySelector('.chat-page-header .model-trigger')?.textContent).toContain(s.group_example_model_id);
    expect(scene?.querySelector('button, input, select, script')).toBeNull();
  });

  it('uses the actual global modal, group page, and chat header entry points', async () => {
    for (const [stage, expected] of [
      ['global', '.sidebar-settings, .global-modal'],
      ['group', '.sidebar-tree .group-item, .group-page'],
      ['inheritedChat', '.chat-page-header .more-trigger, .header-menu, .chat-modal'],
    ] as const) {
      const html = await renderToString(createSSRApp({ render: () => h(SettingsInheritanceStep, { stage, messages: en }) }));
      using page = parsePage({ html });
      const scene = page.document.querySelector(`[data-testid="inheritance-step-${stage}"]`);
      for (const selector of expected.split(', ')) {
        expect(scene?.querySelector(selector)).not.toBeNull();
      }
    }
  });

  it('continues from the prior chat model, changes endpoint and model, then restores the group values', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(SettingsInheritanceStep, { stage: 'reset', messages: en }) }));
    using page = parsePage({ html });
    const scene = page.document.querySelector('[data-testid="inheritance-step-reset"]');
    expect(scene?.textContent).toContain(en.openai_compatible);
    expect(scene?.textContent).toContain('http://localhost:1234/v1');
    expect(scene?.textContent).toContain(en.local_model);
    expect(scene?.textContent).toContain(en.chat_group_ollama);
    const url = scene?.querySelector('[data-testid="inheritance-effective-url"]');
    expect(url?.querySelector('.reset-url-initial')?.textContent).toBe('http://localhost:11434');
    expect(url?.querySelector('.reset-local-url')?.textContent).toBe('http://localhost:1234/v1');
    expect(url?.querySelector('.reset-final')?.textContent).toBe('http://localhost:11434');
    expect(url?.querySelector('.reset-url-pointer')).not.toBeNull();
    expect(scene?.textContent).toContain(en.chat_group_qwen3_4b);
    const header = scene?.querySelector('.chat-page-header .model-trigger');
    expect(header?.querySelector('.reset-initial')?.textContent).toBe(en.chat_example_model_id);
    expect(header?.querySelector('.reset-cleared')?.textContent).toBe(en.group_example_model_id);
    expect(header?.querySelector('.reset-local-model')?.textContent).toBe(en.local_model);
    expect(header?.querySelector('.reset-final')?.textContent).toBe(en.group_example_model_id);
    expect(scene?.querySelector('.endpoint-control .reset-initial')?.textContent).toBe(en.chat_group_ollama);
    expect(scene?.querySelector('.endpoint-control .reset-local-endpoint')?.textContent).toBe(en.openai_compatible);
    expect(scene?.querySelector('.endpoint-control .reset-final')?.textContent).toBe(en.chat_group_ollama);
    expect(scene?.querySelector('.model-control .reset-initial')?.textContent).toBe(en.chat_example_model_id);
    expect(scene?.querySelector('.model-control .reset-local-model')?.textContent).toBe(en.local_model);
    expect(scene?.querySelector('.model-control .reset-final')?.textContent).toBe(en.group_example_model_id);
    expect(scene?.querySelector('button, input, select, script')).toBeNull();
    const filename = new URL('../components/demos/SettingsInheritanceStep.vue', import.meta.url);
    const source = readFileSync(filename, 'utf8');
    const { descriptor } = parse(source, { filename: filename.pathname });
    const style = descriptor.styles[0]?.content;
    expect(style).toMatch(/\.stage-reset \.reset-local-endpoint\s*\{\s*animation:\s*reset-endpoint/);
    expect(style).toMatch(/\.stage-reset \.reset-local-url\s*\{\s*animation:\s*reset-url/);
    expect(style).toMatch(/@keyframes reset-endpoint[^}]+42%/);
    expect(style).toMatch(/@keyframes reset-url \{[^}]+55%/);
  });

  it('updates the chat header label with the selected model', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(SettingsInheritanceStep, { stage: 'chatModel', messages: en }) }));
    using page = parsePage({ html });
    const header = page.document.querySelector('[data-testid="inheritance-step-chatModel"] .chat-page-header .model-trigger');
    expect(header?.querySelector('.phase-start')?.textContent).toBe(en.group_example_model_id);
    expect(header?.querySelector('.phase-end')?.textContent).toBe(en.chat_example_model_id);
  });

  it.each([274, 314, 329, 554])('keeps active fields, chevrons, and pointers inside a %ipx camera without a browser', async cameraWidth => {
    const filename = new URL('../components/demos/SettingsInheritanceStep.vue', import.meta.url);
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname });
    const css = postcss.parse(descriptor.styles[0]?.content ?? '');
    const declaration = ({ selectors, property, narrow }: { selectors: string[]; property: string; narrow: boolean }) => {
      for (const selector of selectors) {
        let value: string | undefined;
        css.walkRules(rule => {
          const inNarrow = rule.parent?.type === 'atrule' && rule.parent.name === 'container' && rule.parent.params === '(max-width:560px)';
          if (inNarrow === narrow && rule.selectors.includes(selector)) {
            rule.walkDecls(property, item => {
              value = item.value;
            });
          }
        });
        if (value !== undefined) {
          return value;
        }
      }
      throw new Error(`Missing ${selectors.join(', ')} ${property}`);
    };
    const length = ({ value }: { value: string }): number => {
      const scalar = /^(-?[\d.]+)(?:px)?$/.exec(value);
      if (scalar) {
        return Number(scalar[1]);
      }
      const fitted = /^min\((-?[\d.]+)px,\s*calc\(100cqw ([+-]) ([\d.]+)px\)\)$/.exec(value);
      if (fitted) {
        return Math.min(Number(fitted[1]), cameraWidth + (fitted[2] === '+' ? 1 : -1) * Number(fitted[3]));
      }
      throw new Error(`Unsupported geometry value ${value}`);
    };
    const pixels = ({ selectors, property, narrow }: { selectors: string[]; property: string; narrow: boolean }) => length({ value: declaration({ selectors, property, narrow }) });
    const horizontalPadding = ({ selector, narrow }: { selector: string; narrow: boolean }) => {
      const parts = declaration({ selectors: [selector], property: 'padding', narrow }).split(/\s+/);
      return length({ value: parts[1] ?? parts[0]! });
    };
    const border = Number.parseFloat(declaration({ selectors: ['.scoped-settings'], property: 'border', narrow: false }));
    const scale = pixels({ selectors: ['.scene-canvas'], property: '--focus-scale', narrow: true });
    const fieldPadding = horizontalPadding({ selector: '.field-value', narrow: false });
    const pointerRight = pixels({ selectors: ['.pointer'], property: 'right', narrow: false });
    for (const stage of ['global', 'group', 'inheritedChat', 'chatModel', 'reset'] as const) {
      const html = await renderToString(createSSRApp({ render: () => h(SettingsInheritanceStep, { stage, messages: en }) }));
      using page = parsePage({ html });
      const icon = page.document.querySelector('.model-control > svg:not(.pointer)');
      const iconWidth = Number(icon?.getAttribute('width'));
      const pointerWidth = Math.max(...[...page.document.querySelectorAll('svg.pointer')].map(item => Number(item.getAttribute('width'))));
      const panel = stage === 'global' ? '.global-modal' : stage === 'group' ? '.group-page' : '.scoped-settings';
      const panelLeft = pixels({ selectors: [panel], property: 'left', narrow: false });
      const panelWidth = pixels({ selectors: [panel], property: 'width', narrow: true });
      const bodyPadding = horizontalPadding({ selector: stage === 'global' ? '.modal-fields' : '.scoped-body', narrow: true });
      const navigationWidth = stage === 'global' ? Number.parseFloat(declaration({ selectors: ['.global-modal'], property: 'grid-template-columns', narrow: false })) : 0;
      const fieldLeft = panelLeft + border + navigationWidth + bodyPadding;
      const fieldRight = panelLeft + panelWidth - border - bodyPadding;
      const focusX = pixels({ selectors: [`.stage-${stage} .scene-canvas`, '.scene-canvas'], property: '--focus-x', narrow: true });
      const visible = ({ left, right, offset, zoom }: { left: number; right: number; offset: number; zoom: number }) => {
        expect(left * zoom + offset, `${stage} left`).toBeGreaterThanOrEqual(0);
        expect(right * zoom + offset, `${stage} right`).toBeLessThanOrEqual(cameraWidth);
      };
      for (const inset of [0, horizontalPadding({ selector: '.connection-details', narrow: true })]) {
        const right = fieldRight - inset;
        visible({ left: fieldLeft + inset, right, offset: focusX, zoom: scale });
        visible({ left: right - border - fieldPadding - iconWidth, right: right - border - fieldPadding, offset: focusX, zoom: scale });
        visible({ left: right - border - pointerRight - pointerWidth, right: right - border - pointerRight, offset: focusX, zoom: scale });
      }
      if (stage === 'inheritedChat' || stage === 'reset') {
        const entryX = pixels({ selectors: [`.stage-${stage} .scene-canvas`], property: '--entry-x', narrow: true });
        const canvasWidth = pixels({ selectors: ['.scene-canvas'], property: 'width', narrow: false });
        const headerPadding = horizontalPadding({ selector: '.chat-page-header', narrow: false });
        const moreWidth = Number(page.document.querySelector('.more-trigger > svg:not(.pointer)')?.getAttribute('width'));
        visible({ left: canvasWidth - headerPadding - moreWidth, right: canvasWidth - headerPadding, offset: entryX, zoom: .85 });
      }
    }
  });
});
