import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileStyle, parse } from '@vue/compiler-sfc';
import postcss from 'postcss';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import CompactPage from '../pages/chat-context-compaction/index.vue';
import GroupsPage from '../pages/chat-groups/index.vue';
import { messages as compactEn } from '../pages/chat-context-compaction/messages/en';
import { messages as compactJa } from '../pages/chat-context-compaction/messages/ja';
import { messages as groupsEn } from '../pages/chat-groups/messages/en';
import { messages as groupsJa } from '../pages/chat-groups/messages/ja';
import { messages as commonEn } from '../messages/common/en';
import { messages as commonJa } from '../messages/common/ja';
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
    expect(document.querySelector('.prerequisite a')?.textContent?.length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.prerequisite a')[1]?.getAttribute('href')).toBe(`/docs/${locale}/in-browser-models/`);
    expect(document.querySelectorAll('section.walkthrough-step')).toHaveLength(4);
    expect([...document.querySelectorAll('section.walkthrough-step')].map(section => section.querySelector('h2')?.textContent)).toEqual([
      copy.open_compact_context_heading, copy.choose_recent_messages_heading, copy.start_summary_heading, copy.review_shorter_path_heading,
    ]);
    expect(document.querySelectorAll('[data-docs-animation^="compact-"]')).toHaveLength(4);
    for (const scene of document.querySelectorAll('[data-docs-animation^="compact-"]')) {
      expect(scene.querySelector('.compact-canvas .chat-header')).not.toBeNull();
      expect([...(scene.querySelectorAll('.more-menu > div') ?? [])].map(item => item.textContent)).toEqual([
        copy.chat_settings, copy.search_in_chat, copy.media_gallery, copy.super_edit, copy.compact_context, copy.print,
      ]);
      expect(scene.querySelector('.more-button svg')?.getAttribute('class')).toContain('lucide-ellipsis-vertical');
      expect(scene.querySelector('.compact-dialog')?.textContent).toContain(copy.messages_to_keep);
      expect(scene.querySelector('.progress-strip')?.textContent).toContain(copy.abort_compact);
      expect(scene.querySelector('.request-preview')?.textContent).toContain(copy.summarize_older_messages_and_preserve_the_decisions);
      expect(scene.querySelector('.output-preview')?.textContent).toContain(copy.the_sources_were_compared_the_next_decision_is);
      expect(scene.querySelector('.compacted-path')?.textContent).toContain(copy.the_sources_have_been_compared_the);
    }
    expect(document.querySelector('[data-testid="compact-step-keep"]')?.textContent).toContain(copy.messages_to_keep);
    expect(document.querySelector('[data-testid="compact-step-run"]')?.textContent).toContain(copy.abort_compact);
    expect(document.querySelector('section[aria-labelledby="compact-run"] > p')?.textContent).toBe(copy.summary_model_location);
    expect(document.querySelector('[data-testid="compact-step-result"]')?.textContent).toContain(copy.the_sources_have_been_compared_the);
    expect(document.querySelector('[data-testid="compact-step-result"]')?.textContent).toContain(copy.let_s_test_the_first_direction);
    const related = document.querySelector('[data-docs-related-guide]');
    expect(related?.getAttribute('aria-label')).toBe(common.related_guides);
    expect(related?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/chat-branching/`);
    expect(related?.textContent).toContain(copy.keep_original_path_while_branching);
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
    expect([...document.querySelectorAll('.prerequisite a')].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/in-browser-models/`, `/docs/${locale}/local-ai-servers/`,
    ]);
    expect([...document.querySelectorAll('section.walkthrough-step')].map(section => section.querySelector('h2')?.textContent)).toEqual([
      copy.create_group_heading, copy.choose_group_model_heading, copy.set_group_instructions_heading,
      copy.move_chat_into_group_heading, copy.start_chat_inside_group_heading, copy.organize_sidebar_heading,
    ]);
    expect(document.querySelectorAll('[data-testid^="group-step-"]')).toHaveLength(4);
    for (const scene of document.querySelectorAll('[data-testid^="group-step-"]')) {
      expect(scene.querySelector('.group-canvas .app-sidebar')).not.toBeNull();
      expect(scene.querySelector('.group-row')?.textContent).toContain(copy.translation);
      expect(scene.querySelector('.move-menu')?.textContent).toContain(copy.top_level);
      expect(scene.querySelector('.header-menu .move-button svg')?.getAttribute('class')).toContain('lucide-folder-input');
      expect(scene.querySelector('.header-menu > span')?.textContent).toBe(copy.chat_settings);
      expect(scene.querySelector('[data-testid="docs-chat-input"]')).not.toBeNull();
      expect(scene.querySelector('[data-testid="docs-chat-input-source"]')).toBeNull();
      expect(scene.querySelector('.nested-items')?.textContent).toContain(copy.add_chat);
    }
    const createScene = document.querySelector('[data-testid="group-step-create"]');
    expect(createScene?.textContent).toContain(copy.translation);
    expect(createScene?.querySelector('.creation-row .entry-name')).not.toBeNull();
    expect(createScene?.querySelector('[data-testid="group-rename-dialog"]')).toBeNull();
    expect(createScene?.querySelector('.chat-input-model-name')?.textContent).toBe(copy.gemma3n_e2b);
    const moveScene = document.querySelector('[data-testid="group-step-move"]');
    expect(moveScene?.querySelector('.composer-before .chat-input-model-name')?.textContent).toBe(copy.gemma3n_e2b);
    expect(moveScene?.querySelector('.composer-after .chat-input-model-name')?.textContent).toBe(copy.qwen3_4b);
    for (const stage of ['add', 'tidy']) {
      expect(document.querySelector(`[data-testid="group-step-${stage}"] .chat-input-model-name`)?.textContent).toBe(copy.qwen3_4b);
    }
    const renameDialog = document.querySelector('[data-testid="group-step-tidy"] [data-testid="group-rename-dialog"]');
    expect(renameDialog?.querySelector('.rename-input')?.textContent).toBe(copy.english_translation);
    expect(renameDialog?.querySelector('.rename-actions')?.textContent).toBe(copy.cancel + copy.save);
    expect(document.querySelector('[data-testid="group-step-tidy"] .group-row .rename-input')).toBeNull();
    expect(document.querySelector('[data-testid="group-step-move"]')?.textContent).toContain(copy.top_level);
    expect(document.querySelector('[data-testid="group-step-add"]')?.textContent).toContain(copy.new_chat);
    const modelScene = document.querySelector('[data-testid="group-settings-model"]');
    const promptScene = document.querySelector('[data-testid="group-settings-prompt"]');
    expect(modelScene?.getAttribute('data-docs-animation')).toBe('group-settings-model');
    expect(modelScene?.querySelector('.group-row')?.textContent).toContain(copy.translation);
    expect(modelScene?.querySelector('.app-sidebar > .top-chat-row')?.textContent).toBe(copy.page_copy);
    expect(modelScene?.querySelector('.model-control')?.textContent).toContain(copy.gemma3n_e2b);
    expect(modelScene?.querySelector('.model-control')?.textContent).toContain(copy.qwen3_4b);
    expect(modelScene?.querySelector('.connection-summary .source-badge')?.textContent).toBe(copy.source_global);
    expect(modelScene?.querySelector('.connection-summary .endpoint-url')?.textContent).toBe('http://localhost:11434');
    expect(modelScene?.querySelector('.model-control .source-badge')?.textContent).toBe(copy.source_global);
    expect(modelScene?.querySelector('.reasoning')?.textContent).toContain(copy.reasoning);
    expect(promptScene?.getAttribute('data-docs-animation')).toBe('group-settings-prompt');
    expect(promptScene?.querySelector('.app-sidebar > .top-chat-row')?.textContent).toBe(copy.page_copy);
    expect(promptScene?.querySelector('.mode-control')?.textContent).toContain(copy.replace);
    expect(promptScene?.querySelector('.prompt-input')?.textContent).toContain(copy.translate_the_user_s_text_into);
    expect(document.querySelectorAll('script, [data-docs-island]')).toHaveLength(0);
    const related = document.querySelector('[data-docs-related-guide]');
    expect(related?.getAttribute('aria-label')).toBe(common.related_guides);
    expect(related?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/settings-inheritance/`);
    expect(related?.textContent).toContain(copy.understand_model_inheritance);
  });

  it('keeps paused group settings scoped to its completed scene', () => {
    const filename = new URL('../components/demos/ChatGroupSettingsStep.vue', import.meta.url);
    const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname });
    expect(errors).toHaveLength(0);
    const style = descriptor.styles[0];
    if (!style) {
      throw new Error('Missing ChatGroupSettingsStep style');
    }
    const compiled = compileStyle({ source: style.content, filename: filename.pathname, id: 'data-v-test', scoped: true });
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.code).toContain('html:has(#docs-pause-motion:checked) .stage-model .selected-value');
    expect(compiled.code).toContain('html:has(#docs-pause-motion:checked) .stage-prompt .prompt-text');
    expect(compiled.code).not.toMatch(/html:has\(#docs-pause-motion:checked\)\s*\{/);
  });

  it('changes the composer model with sidebar membership and leaves the moved model when motion stops', () => {
    const filename = new URL('../components/demos/ChatGroupStep.vue', import.meta.url);
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname });
    const css = postcss.parse(descriptor.styles[0]?.content ?? '');
    const declaration = ({ selector, property }: { selector: string; property: string }) => {
      let value: string | undefined;
      css.walkRules(rule => {
        if (rule.selectors.includes(selector)) {
          rule.walkDecls(property, item => {
            value = item.value;
          });
        }
      });
      if (value === undefined) {
        throw new Error(`Missing ${selector} ${property}`);
      }
      return value;
    };
    expect(declaration({ selector: '.composer-before', property: 'animation' })).toBe(declaration({ selector: '.stage-move .top-chat', property: 'animation' }));
    expect(declaration({ selector: '.composer-after', property: 'animation' })).toBe(declaration({ selector: '.stage-move .first-chat', property: 'animation' }));
    expect(declaration({ selector: '.composer-before', property: 'opacity' })).toBe('0');
    expect(declaration({ selector: '.composer-after', property: 'opacity' })).toBe('1');
  });
});
