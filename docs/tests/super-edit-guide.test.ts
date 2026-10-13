import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import SuperEditPage from '../pages/chat/super-edit.vue';
import { strings as en } from '../strings/chat/super-edit/en';
import { strings as ja } from '../strings/chat/super-edit/ja';
import { strings as commonEn } from '../strings/common/en';
import { strings as commonJa } from '../strings/common/ja';

describe('Super Edit guide', () => {
  it.each([
    { locale: 'en' as const, copy: en, common: commonEn },
    { locale: 'ja' as const, copy: ja, common: commonJa },
  ])('renders the full workflow and its preserved-path result in $locale', async ({ locale, copy, common }) => {
    const html = await renderToString(createSSRApp(SuperEditPage, { s: copy, locale, common }));

    for (const stage of ['open', 'edit', 'prompt', 'apply']) {
      expect(html).toContain(`data-docs-animation="super-edit-${stage}"`);
    }
    expect(html).toContain(copy.demo.superEdit);
    expect(html).toContain(copy.demo.branchNotice);
    expect(html).toContain(copy.demo.originalPath);
    expect(html).toContain(copy.demo.editedPath);
    expect(html).toContain(copy.steps.prompt.title);
    expect(html).toContain(copy.steps.apply.title);
    expect(html).toContain(`href="/docs/${locale}/chat/branching/"`);
    expect(html).toContain('class="ui-label"');
    expect(html).not.toContain('<button');
  });
});
