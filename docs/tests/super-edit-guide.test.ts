import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import SuperEditPage from '../pages/chat-super-edit/index.vue';
import { messages as en } from '../pages/chat-super-edit/messages/en';
import { messages as ja } from '../pages/chat-super-edit/messages/ja';
import { messages as commonEn } from '../messages/common/en';
import { messages as commonJa } from '../messages/common/ja';

describe('Super Edit guide', () => {
  it.each([
    { locale: 'en' as const, copy: en, common: commonEn },
    { locale: 'ja' as const, copy: ja, common: commonJa },
  ])('renders the full workflow and its preserved-path result in $locale', async ({ locale, copy, common }) => {
    const html = await renderToString(createSSRApp(SuperEditPage, { s: copy, locale, common }));
    expect(html).toContain('data-docs-app-entry-path="/#/"');

    for (const stage of ['open', 'edit', 'prompt', 'apply']) {
      expect(html).toContain(`data-docs-animation="super-edit-${stage}"`);
    }
    expect(html).toContain(copy.super_edit);
    expect(html).toContain(copy.applying_changes_creates_a_new_branch);
    expect(html).toContain(copy.original_path);
    expect(html).toContain(copy.edited_path);
    expect(html).toContain(copy.check_chat_system_prompt_heading);
    expect(html).toContain(copy.apply_new_path_heading);
    expect(html).toContain(`href="/docs/${locale}/chat-branching/"`);
    expect(html).toContain('class="ui-label"');
    expect(html).not.toContain('<button');
  });
});
