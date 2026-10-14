import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileStyle, parse } from '@vue/compiler-sfc';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import CompactPage from '../pages/chat-context-compaction/index.vue';
import GroupsPage from '../pages/chat-groups/index.vue';
import { strings as compactEn } from '../pages/chat-context-compaction/strings/en';
import { strings as compactJa } from '../pages/chat-context-compaction/strings/ja';
import { strings as groupsEn } from '../pages/chat-groups/strings/en';
import { strings as groupsJa } from '../pages/chat-groups/strings/ja';
import { strings as commonEn } from '../strings/common/en';
import { strings as commonJa } from '../strings/common/ja';
import { parsePage } from './site.test-support';

describe('conversation guides', () => {
  it.each([
    { locale: 'en' as const, copy: compactEn, common: commonEn },
    { locale: 'ja' as const, copy: compactJa, common: commonJa },
  ])('renders the full $locale compact workflow as static HTML', async ({ locale, copy, common }) => {
    const html = await renderToString(createSSRApp(CompactPage, { s: copy, locale, common }));
    using page = parsePage({ html });
    const { document } = page;
    expect(document.querySelector('.app-entry-intro a[data-docs-app-entry-path="/#/"]')?.textContent).toBe('Naidan');
    expect(document.querySelector('.prerequisite a')?.getAttribute('href')).toBe(`/docs/${locale}/local-ai-servers/`);
    expect(document.querySelector('.prerequisite a')?.textContent).toBe(copy.setup.link);
    expect(document.querySelectorAll('.prerequisite a')[1]?.getAttribute('href')).toBe(`/docs/${locale}/in-browser-models/`);
    expect(document.querySelectorAll('section.walkthrough-step')).toHaveLength(4);
    expect([...document.querySelectorAll('section.walkthrough-step')].map(section => section.querySelector('h2')?.textContent)).toEqual([
      copy.steps.open.title, copy.steps.keep.title, copy.steps.run.title, copy.steps.result.title,
    ]);
    expect(document.querySelectorAll('[data-docs-animation^="compact-"]')).toHaveLength(4);
    for (const scene of document.querySelectorAll('[data-docs-animation^="compact-"]')) {
      expect(scene.querySelector('.compact-canvas .chat-header')).not.toBeNull();
      expect(scene.querySelector('.more-menu')?.textContent).toContain(copy.demo.compactContext);
      expect(scene.querySelector('.more-button svg')?.getAttribute('class')).toContain('lucide-ellipsis-vertical');
      expect(scene.querySelector('.compact-dialog')?.textContent).toContain(copy.demo.messagesToKeep);
      expect(scene.querySelector('.progress-strip')?.textContent).toContain(copy.demo.abortCompact);
      expect(scene.querySelector('.request-preview')?.textContent).toContain(copy.demo.requestExcerpt);
      expect(scene.querySelector('.output-preview')?.textContent).toContain(copy.demo.outputExcerpt);
      expect(scene.querySelector('.compacted-path')?.textContent).toContain(copy.demo.summary);
    }
    expect(document.querySelector('[data-testid="compact-step-keep"]')?.textContent).toContain(copy.demo.messagesToKeep);
    expect(document.querySelector('[data-testid="compact-step-run"]')?.textContent).toContain(copy.demo.abortCompact);
    expect(document.querySelector('[data-testid="compact-step-result"]')?.textContent).toContain(copy.demo.summary);
    expect(document.querySelector('[data-testid="compact-step-result"]')?.textContent).toContain(copy.demo.recentMessage);
    const related = document.querySelector('[data-docs-related-guide]');
    expect(related?.getAttribute('aria-label')).toBe(common.relatedGuides);
    expect(related?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/chat-branching/`);
    expect(related?.textContent).toContain(copy.nextDescription);
  });

  it.each([
    { locale: 'en' as const, copy: groupsEn, common: commonEn },
    { locale: 'ja' as const, copy: groupsJa, common: commonJa },
  ])('renders the full $locale group workflow as static HTML', async ({ locale, copy, common }) => {
    const html = await renderToString(createSSRApp(GroupsPage, { s: copy, locale, common }));
    using page = parsePage({ html });
    const { document } = page;
    expect(document.querySelector('.app-entry-intro a[data-docs-app-entry-path="/#/"]')?.textContent).toBe('Naidan');
    expect(document.querySelector('h1')?.textContent).toBe(copy.title);
    expect(document.querySelector('.prerequisite a')?.getAttribute('href')).toBe(`/docs/${locale}/local-ai-servers/`);
    expect([...document.querySelectorAll('section.walkthrough-step')].map(section => section.querySelector('h2')?.textContent)).toEqual([
      copy.steps.create.title, copy.steps.model.title, copy.steps.prompt.title,
      copy.steps.move.title, copy.steps.add.title, copy.steps.tidy.title,
    ]);
    expect(document.querySelectorAll('[data-testid^="group-step-"]')).toHaveLength(4);
    for (const scene of document.querySelectorAll('[data-testid^="group-step-"]')) {
      expect(scene.querySelector('.group-canvas .app-sidebar')).not.toBeNull();
      expect(scene.querySelector('.group-row')?.textContent).toContain(copy.demo.group);
      expect(scene.querySelector('.move-menu')?.textContent).toContain(copy.demo.topLevel);
      expect(scene.querySelector('.move-button svg')?.getAttribute('class')).toContain('lucide-folder-input');
      expect(scene.querySelector('.nested-items')?.textContent).toContain(copy.demo.addChat);
    }
    expect(document.querySelector('[data-testid="group-step-create"]')?.textContent).toContain(copy.demo.group);
    expect(document.querySelector('[data-testid="group-step-move"]')?.textContent).toContain(copy.demo.topLevel);
    expect(document.querySelector('[data-testid="group-step-add"]')?.textContent).toContain(copy.demo.chatTwo);
    const modelScene = document.querySelector('[data-testid="group-settings-model"]');
    const promptScene = document.querySelector('[data-testid="group-settings-prompt"]');
    expect(modelScene?.getAttribute('data-docs-animation')).toBe('group-settings-model');
    expect(modelScene?.querySelector('.group-row')?.textContent).toContain(copy.settingsDemo.group);
    expect(modelScene?.querySelector('.app-sidebar > .top-chat-row')?.textContent).toBe(copy.settingsDemo.chat);
    expect(modelScene?.querySelector('.model-control')?.textContent).toContain(copy.settingsDemo.inheritedModel);
    expect(modelScene?.querySelector('.model-control')?.textContent).toContain(copy.settingsDemo.selectedModel);
    expect(promptScene?.getAttribute('data-docs-animation')).toBe('group-settings-prompt');
    expect(promptScene?.querySelector('.app-sidebar > .top-chat-row')?.textContent).toBe(copy.settingsDemo.chat);
    expect(promptScene?.querySelector('.mode-control')?.textContent).toContain(copy.settingsDemo.promptModes.replace);
    expect(promptScene?.querySelector('.prompt-input')?.textContent).toContain(copy.settingsDemo.promptText);
    expect(document.querySelectorAll('script, [data-docs-island]')).toHaveLength(0);
    const related = document.querySelector('[data-docs-related-guide]');
    expect(related?.getAttribute('aria-label')).toBe(common.relatedGuides);
    expect(related?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/settings-inheritance/`);
    expect(related?.textContent).toContain(copy.nextDescription);
  });

  it('keeps paused group settings scoped to its completed scene', () => {
    const filename = new URL('../site/demos/GroupSettingsStep.vue', import.meta.url);
    const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname });
    expect(errors).toHaveLength(0);
    const style = descriptor.styles[0];
    if (!style) throw new Error('Missing GroupSettingsStep style');
    const compiled = compileStyle({ source: style.content, filename: filename.pathname, id: 'data-v-test', scoped: true });
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.code).toContain('html:has(#docs-pause-motion:checked) .stage-model .selected-value');
    expect(compiled.code).toContain('html:has(#docs-pause-motion:checked) .stage-prompt .prompt-text');
    expect(compiled.code).not.toMatch(/html:has\(#docs-pause-motion:checked\)\s*\{/);
  });
});
