import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import WeshSysfsGuide from '../pages/wesh-sysfs/index.vue';
import { messages as english } from '../pages/wesh-sysfs/messages/en';
import { messages as japanese } from '../pages/wesh-sysfs/messages/ja';
import { messages as commonEnglish } from '../messages/common/en';
import { messages as commonJapanese } from '../messages/common/ja';
import { parsePage } from './site.test-support';

describe('Wesh sysfs guide', () => {
  it.each([
    { locale: 'en', s: english, common: commonEnglish },
    { locale: 'ja', s: japanese, common: commonJapanese },
  ] as const)('explains AI reuse before access choices and keeps verification paths available in $locale HTML', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp(WeshSysfsGuide, { locale, s, common }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-wesh-sysfs"]');

    expect(article?.querySelector('h1')).not.toBeNull();
    expect(article?.querySelector('[data-docs-app-entry-path]')?.getAttribute('data-docs-app-entry-path')).toBe('/#/');
    expect(article?.querySelector('p.lead')?.textContent).toContain('/sys/fs/naidan');
    const sectionIds = [...article?.querySelectorAll(':scope > section h2[id]') ?? []].map(heading => heading.id);
    expect(sectionIds.slice(0, 5)).toEqual(['sysfs-purpose', 'sysfs-filesystem', 'sysfs-example', 'sysfs-scope', 'sysfs-start']);
    const example = article?.querySelector('[data-testid="docs-wesh-sysfs-example"]');
    expect(example?.textContent).toContain(locale === 'en' ? 'other Chat Groups and branches' : '別のチャットグループや分岐');
    expect(example?.textContent).toContain(locale === 'en' ? 'candidate Markdown paths' : '候補Markdownパス');
    expect(example?.textContent).toContain('branches/leaves-md/');
    expect(example?.textContent).toContain('current-chat/content-md/');
    const pipeline = example?.querySelector('pre code')?.textContent ?? '';
    expect(pipeline).toMatch(/^grep -r -l .+ \/sys\/fs\/naidan\/chats \| sed -n '\/\\\.md\$\/p' \| head -n 10$/u);
    expect(pipeline).not.toMatch(/\{id\}|<id>|ID_FROM_LIST/u);
    const start = article?.querySelector('#sysfs-start')?.parentElement;
    expect(start?.textContent).toContain(locale === 'en' ? 'Wesh Terminal' : 'Wesh ターミナル');
    expect(start?.textContent).toContain(locale === 'en' ? 'Mount' : 'マウント');
    expect(article?.querySelector('.session-note')?.textContent).toContain(locale === 'en' ? 'Close Session' : 'セッションを閉じる');

    const rows = [...article?.querySelectorAll<HTMLTableRowElement>('[data-testid="docs-wesh-sysfs-scope"] tbody tr') ?? []];
    expect(rows).toHaveLength(4);
    expect(rows[1]?.cells[1]?.textContent).toMatch(locale === 'en' ? /other chats.*unavailable/i : /ほかのチャットの会話本文は読めません/);
    expect(rows[1]?.cells[2]?.textContent).toMatch(locale === 'en' ? /all saved binary objects/i : /全件一覧・読み取り/);
    expect(article?.querySelector('#sysfs-scope')?.parentElement?.textContent).toContain(locale === 'en' ? 'member chat IDs' : '所属チャットのID');
    expect(article?.querySelector('[data-testid="docs-wesh-sysfs-paths"]')?.textContent).toContain('binary-objects/by-id/');

    const examples = [...article?.querySelectorAll('#sysfs-read + p ~ pre code') ?? []].map(node => node.textContent);
    expect(examples.join('\n')).toContain('cat /sys/fs/naidan/current-chat/metadata.md');
    expect(examples.join('\n')).toContain('ls /sys/fs/naidan/binary-objects/by-id');
    expect(examples.join('\n')).not.toMatch(/\{id\}|<id>|ID_FROM_LIST/u);
    expect(article?.textContent).toContain('/sys/fs/naidan/binary-objects/by-id/{id}/data');
    expect([...article?.querySelectorAll('[data-docs-related-guide] a') ?? []].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/tool-browser-shell/`, `/docs/${locale}/tool-wikipedia/`,
      `/docs/${locale}/files-and-folders-settings/`, `/docs/${locale}/file-explorer/`,
    ]);
  });
});
