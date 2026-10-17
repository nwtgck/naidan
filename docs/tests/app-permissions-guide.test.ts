import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import AppPermissionsPage from '../pages/web-and-native-app-permissions/index.vue';
import { messages as english } from '../pages/web-and-native-app-permissions/messages/en';
import { messages as japanese } from '../pages/web-and-native-app-permissions/messages/ja';
import { messages as commonEnglish } from '../messages/common/en';
import { messages as commonJapanese } from '../messages/common/ja';
import { parsePage } from './site.test-support';

describe('app permissions comparison guide', () => {
  it.each([
    { locale: 'en', s: english, common: commonEnglish },
    { locale: 'ja', s: japanese, common: commonJapanese },
  ] as const)('shows access and outbound communication as separate decisions in $locale HTML', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(AppPermissionsPage, { locale, s, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-app-permissions"]');
    const captions = {
      desktop: s.desktop_access_caption,
      mobile: s.mobile_access_caption,
      web: s.web_access_caption,
      send: s.sending_paths_caption,
      noPrompt: s.permission_paths_caption,
    };
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect([...article?.querySelectorAll('h2') ?? []].map(heading => heading.textContent)).toEqual([
      s.device_access_title,
      s.sending_information_title,
      s.permission_prompt_title,
      s.choosing_app_form_title,
    ]);

    expect([...article?.querySelectorAll('.access-example h3') ?? []].map(heading => heading.textContent)).toEqual([s.desktop_access_title, s.mobile_access_title, s.web_access_title]);
    for (const mode of ['desktop', 'mobile', 'web', 'send', 'noPrompt'] as const) {
      const diagram = article?.querySelector(`[data-testid="app-permissions-${mode}-diagram"]`);
      expect(diagram?.getAttribute('aria-label')).toBe(captions[mode]);
      expect(diagram?.closest('figure')?.querySelector('figcaption')?.textContent).toBe(captions[mode]);
    }
    expect(article?.textContent?.indexOf(s.desktop_access_title)).toBeLessThan(article?.textContent?.indexOf(s.sending_information_title) ?? 0);
    expect(article?.textContent?.indexOf(s.sending_information_title)).toBeLessThan(article?.textContent?.indexOf(s.permission_prompt_title) ?? 0);
    const consentDiagram = article?.querySelector('[data-testid="app-permissions-noPrompt-diagram"]');
    expect(consentDiagram?.textContent).toContain(s.os_grants_automatically);
    expect(consentDiagram?.textContent).toContain(s.android_asks_user);
    const sendDiagram = article?.querySelector('[data-testid="app-permissions-send-diagram"]');
    expect(sendDiagram?.textContent).toContain(s.web_page_via_browser_http);
    expect(sendDiagram?.textContent).toContain(s.example_service);
    expect(sendDiagram?.textContent).toContain(s.draft_text_sample);
    expect(sendDiagram?.textContent).toContain(s.accelerometer_sample_value);
    expect(sendDiagram?.textContent).toContain(s.web_example_file_name);
    expect(article?.textContent).toContain('Android');
    expect(article?.textContent).toContain('TCP');
    expect(article?.textContent).toContain('UDP');

    const evidence = [...article?.querySelectorAll<HTMLAnchorElement>('a[href^="https://"]') ?? []];
    expect(evidence.length).toBeGreaterThanOrEqual(9);
    for (const link of evidence) {
      expect(link.querySelector('[data-docs-external-icon]')).not.toBeNull();
    }
    expect([...article?.querySelectorAll('[data-docs-related-guide] a') ?? []].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/browser-boundaries/`,
      `/docs/${locale}/csp-editions/`,
      `/docs/${locale}/standalone/`,
    ]);
  });
});
