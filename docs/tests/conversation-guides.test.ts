import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import CompactPage from '../pages/chat/compact.vue';
import GroupsPage from '../pages/chat/groups.vue';
import { strings as compactEn } from '../strings/chat/compact/en';
import { strings as compactJa } from '../strings/chat/compact/ja';
import { strings as groupsEn } from '../strings/chat/groups/en';
import { strings as groupsJa } from '../strings/chat/groups/ja';
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
    expect(document.querySelector('.app-entry-intro a[data-docs-app-entry-path="/#/"]')?.textContent).toBe('/#/');
    expect(document.querySelector('.prerequisite a')?.getAttribute('href')).toBe(`/docs/${locale}/models/local-engines/`);
    expect(document.querySelector('.prerequisite a')?.textContent).toBe(copy.setup.link);
    expect(document.querySelectorAll('.prerequisite a')[1]?.getAttribute('href')).toBe(`/docs/${locale}/models/in-browser/`);
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
    expect(related?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/chat/branching/`);
    expect(related?.textContent).toContain(copy.nextDescription);
  });

  it.each([
    { locale: 'en' as const, copy: groupsEn, common: commonEn },
    { locale: 'ja' as const, copy: groupsJa, common: commonJa },
  ])('renders the full $locale group workflow as static HTML', async ({ locale, copy, common }) => {
    const html = await renderToString(createSSRApp(GroupsPage, { s: copy, locale, common }));
    using page = parsePage({ html });
    const { document } = page;
    expect(document.querySelector('.app-entry-intro a[data-docs-app-entry-path="/#/"]')?.textContent).toBe('/#/');
    expect(document.querySelectorAll('section.walkthrough-step')).toHaveLength(4);
    expect([...document.querySelectorAll('section.walkthrough-step')].map(section => section.querySelector('h2')?.textContent)).toEqual([
      copy.steps.create.title, copy.steps.move.title, copy.steps.add.title, copy.steps.tidy.title,
    ]);
    expect(document.querySelectorAll('[data-docs-animation^="group-"]')).toHaveLength(4);
    for (const scene of document.querySelectorAll('[data-docs-animation^="group-"]')) {
      expect(scene.querySelector('.group-canvas .app-sidebar')).not.toBeNull();
      expect(scene.querySelector('.group-row')?.textContent).toContain(copy.demo.group);
      expect(scene.querySelector('.move-menu')?.textContent).toContain(copy.demo.topLevel);
      expect(scene.querySelector('.move-button svg')?.getAttribute('class')).toContain('lucide-folder-input');
      expect(scene.querySelector('.nested-items')?.textContent).toContain(copy.demo.addChat);
    }
    expect(document.querySelector('[data-testid="group-step-create"]')?.textContent).toContain(copy.demo.group);
    expect(document.querySelector('[data-testid="group-step-move"]')?.textContent).toContain(copy.demo.topLevel);
    expect(document.querySelector('[data-testid="group-step-add"]')?.textContent).toContain(copy.demo.chatTwo);
    const related = document.querySelector('[data-docs-related-guide]');
    expect(related?.getAttribute('aria-label')).toBe(common.relatedGuides);
    expect(related?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/settings/inheritance/`);
    expect(related?.textContent).toContain(copy.nextDescription);
  });
});
