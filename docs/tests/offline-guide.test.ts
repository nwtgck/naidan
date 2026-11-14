import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import OfflinePage from '../pages/pwa/index.vue';
import { messages as english } from '../pages/pwa/messages/en';
import { messages as japanese } from '../pages/pwa/messages/ja';
import { messages as commonEnglish } from '../messages/common/en';
import { messages as commonJapanese } from '../messages/common/ja';
import { parsePage } from './site.test-support';

describe('offline browser AI guide', () => {
  it.each([
    { locale: 'en', s: english, common: commonEnglish, importControls: ['Copy model files into the browser', 'Load model', 'Save in browser', 'Link folder'], waitBeforeReload: 'Wait for saving to finish before reloading.', temporaryBoundary: 'selected files last until this page reloads or closes' },
    { locale: 'ja', s: japanese, common: commonJapanese, importControls: ['モデルファイルをブラウザ内にコピー', 'モデルを読み込む', 'ブラウザに保存', 'フォルダをリンク'], waitBeforeReload: '再読み込み前に保存完了を確認してください。', temporaryBoundary: '選んだファイルはこのページを再読み込みするか閉じるまで使えます' },
  ] as const)('renders the online preparation and offline verification journey in $locale', async ({ locale, s, common, importControls, waitBeforeReload, temporaryBoundary }) => {
    const html = await renderToString(createSSRApp(OfflinePage, { locale, s, common }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-run-offline"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect(article?.querySelector('.app-entry-intro a[data-docs-app-entry-path]')?.textContent).toBe('Naidan');
    expect([...article?.querySelectorAll('section.walkthrough-step h2') ?? []].map(heading => heading.textContent)).toEqual([
      s.prepare_app_online_title, s.prepare_local_model_title, s.verify_offline_title, s.apply_update_title,
    ]);
    expect([...article?.querySelectorAll('section.walkthrough-step [data-docs-animation]') ?? []].map(scene => scene.getAttribute('data-testid'))).toEqual([
      'offline-step-prepare', 'offline-step-model', 'offline-step-verify', 'offline-step-update',
    ]);
    expect(article?.querySelector('[data-testid="offline-step-model"]')?.textContent).toContain(s.model_file_name);
    expect(article?.querySelector('[data-testid="offline-step-verify"]')?.textContent).toContain(s.offline_status);
    const reloadGuidance = article?.querySelector('[data-testid="offline-model-reload-guidance"]');
    expect([...reloadGuidance?.querySelectorAll('.ui-label') ?? []].map(label => label.textContent)).toEqual(expect.arrayContaining([...importControls]));
    expect(reloadGuidance?.textContent).toContain(waitBeforeReload);
    expect(reloadGuidance?.textContent).toContain(temporaryBoundary);
    const chatInputs = article?.querySelectorAll('[data-testid="docs-chat-input"]');
    expect(chatInputs).toHaveLength(2);
    for (const input of chatInputs ?? []) {
      expect(input.querySelector('[data-testid="docs-chat-input-text"]')?.textContent).toBe(common.chrome_input_placeholder);
      expect(input.querySelector('[data-testid="docs-chat-input-model"]')?.textContent).toBe(s.model_file_name);
      expect(input.querySelector('[data-testid="docs-chat-input-send"] .lucide-arrow-up')).not.toBeNull();
    }
    const update = article?.querySelector('[data-testid="offline-step-update"]');
    expect(update?.textContent).toContain(s.ready_update_label);
    expect(update?.querySelector('.update-warning')?.textContent).toBe(s.network_update_warning);
    expect(article?.textContent).toContain(s.offline_feature_limitations);
    expect(article?.querySelectorAll('figure button, figure input, figure a')).toHaveLength(0);
    expect(article?.querySelectorAll('figure .lucide-send')).toHaveLength(0);
    expect([...article?.querySelectorAll('[data-docs-related-guide] a') ?? []].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/endpoint-type-llama-cpp-browser/`,
      `/docs/${locale}/in-browser-model/`,
      `/docs/${locale}/standalone/`,
      `/docs/${locale}/hosted/`,
    ]);
  });
});
