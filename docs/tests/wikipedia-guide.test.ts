import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import WikipediaGuide from '../pages/tool-wikipedia/index.vue';
import { messages as en } from '../pages/tool-wikipedia/messages/en';
import { messages as ja } from '../pages/tool-wikipedia/messages/ja';
import { messages as commonEn } from '../messages/common/en';
import { messages as commonJa } from '../messages/common/ja';
import { parsePage } from './site.test-support';

describe('Wikipedia chat guide', () => {
  it.each(['en', 'ja'] as const)('renders the complete consent path and privacy scope in %s', async locale => {
    const s = locale === 'en' ? en : ja;
    const common = locale === 'en' ? commonEn : commonJa;
    const html = await renderToString(createSSRApp({ render: () => h(WikipediaGuide, { s, locale, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-wikipedia"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect(article?.querySelector('[data-docs-app-entry-path]')?.getAttribute('data-docs-app-entry-path')).toBe('/#/');
    const modelEntry = article?.querySelector('.prerequisite [data-docs-app-entry-path]');
    const modelPath = modelEntry?.getAttribute('data-docs-app-entry-path') ?? '';
    expect(modelEntry?.textContent).toContain('Qwen3.5 9B');
    expect(modelPath).toMatch(/^\/#\/\?/);
    expect(new URLSearchParams(modelPath.split('?')[1]).get('llama-cpp-browser-model')).toBe('hf.co/lmstudio-community/Qwen3.5-9B-GGUF:Q4_K_M');

    const steps = [...(article?.querySelectorAll('.walkthrough-step') ?? [])];
    expect(steps.map(step => step.querySelector('[data-docs-animation]')?.getAttribute('data-docs-animation'))).toEqual([
      'wikipedia-settings-open',
      'wikipedia-settings-enabled',
      'wikipedia-chat-search',
      'wikipedia-chat-page',
    ]);
    const tools = steps[0]?.querySelector('[data-testid="docs-chat-input-tools"]');
    expect(tools?.querySelector('[data-testid="docs-wikipedia-open-pointer"]')).not.toBeNull();
    expect(steps[0]?.textContent).toContain(s.tool_session_notice);
    expect(steps[1]?.textContent).toContain('/sys/fs/naidan');
    expect(steps[1]?.textContent).toContain(s.current_chat_scope);
    expect(steps[1]?.textContent).toContain(s.shell_tool);
    expect(steps[1]?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/wesh-sysfs/`);
    expect(steps[2]?.querySelector('.approval-preview')?.textContent).toContain(s.aurora_search_term);
    expect(steps[3]?.querySelector('.approval-preview')?.textContent).toContain(s.aurora_page_id);
    expect(steps[3]?.querySelector('.user-message')?.textContent).toBe(s.aurora_question);
    expect(steps[2]?.querySelector('.approval-panel')?.textContent).toContain(s.allow_once);
    expect(steps[2]?.textContent).toContain(s.allow_for_chat);
    expect(steps[2]?.textContent).toContain(s.allow_globally);
    expect(steps[2]?.querySelector('p')?.textContent).toContain(locale === 'en' ? 'The Curated hosted version' : 'Curated版のCSP');
    expect(steps[2]?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/csp-editions/`);
    expect(steps[3]?.querySelector('.approval-panel')?.textContent).toContain(s.allow_once);
    expect(article?.querySelector('[data-testid="wikipedia-chat-result"] .assistant-message')?.textContent).toBe(s.aurora_answer);
    expect(steps[2]?.querySelector('[data-testid="docs-chat-input"]')?.getAttribute('data-status')).toBe('generating');
    expect(article?.querySelector('[data-testid="wikipedia-chat-result"] [data-testid="docs-chat-input"]')?.getAttribute('data-status')).toBe('idle');

    const privacy = article?.querySelector('.privacy-section');
    expect(privacy?.textContent).toContain('Origin');
    expect(privacy?.textContent).toContain('IP');
  });
});
