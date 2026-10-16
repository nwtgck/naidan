import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import LocalOnlyPage from '../pages/csp-editions/index.vue';
import { messages as english } from '../pages/csp-editions/messages/en';
import { messages as japanese } from '../pages/csp-editions/messages/ja';
import { messages as commonEnglish } from '../messages/common/en';
import { messages as commonJapanese } from '../messages/common/ja';
import { parsePage } from './site.test-support';

describe('Local-only connection guide', () => {
  it.each([
    { locale: 'en', s: english, common: commonEnglish },
    { locale: 'ja', s: japanese, common: commonJapanese },
  ] as const)('offers the three actual hosted versions and a checkable local policy in $locale HTML', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(LocalOnlyPage, { locale, s, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-local-only"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect([...article?.querySelectorAll('h2') ?? []].map(heading => heading.textContent)).toEqual([
      s.choose_hosted_version_title,
      s.connect_local_server_title,
      s.connection_policy_scope_title,
      s.inspect_policy_and_traffic_title,
    ]);

    const hostedLinks = [...article?.querySelectorAll<HTMLAnchorElement>('.version-card a[data-docs-external]') ?? []];
    expect(hostedLinks.map(link => link.getAttribute('href'))).toEqual([
      'https://naidan-local-only.pages.dev/',
      'https://naidan-curated.pages.dev/',
      'https://naidan.pages.dev/',
    ]);
    for (const link of hostedLinks) {
      expect(link.querySelector('[data-docs-external-icon]')).not.toBeNull();
    }
    expect(article?.querySelector('.switching-note a')?.getAttribute('href')).toBe(`/docs/${locale}/data-backup/`);
    const diagram = article?.querySelector('[data-testid="connection-policy-diagram"]');
    expect(diagram?.querySelectorAll('.policy-row')).toHaveLength(3);
    for (const row of diagram?.querySelectorAll('.policy-row') ?? []) {
      expect(row.querySelector('.branch-routes')?.querySelectorAll('[data-source="page"]')).toHaveLength(2);
      expect([...row.querySelectorAll('.branch-routes > .route')].map(route => route.getAttribute('data-destination'))).toEqual(['local', 'external']);
    }
    expect([...diagram?.querySelectorAll('[data-destination="local"]') ?? []].map(route => route.getAttribute('data-state'))).toEqual([
      'allowed', 'allowed', 'standard',
    ]);
    expect([...diagram?.querySelectorAll('[data-destination="external"]') ?? []].map(route => route.getAttribute('data-state'))).toEqual([
      'blocked', 'allowed', 'standard',
    ]);
    expect(diagram?.textContent).toContain(s.curated_external_services);
    expect(diagram?.textContent).toContain(s.standard_connection_limit);
    expect(article?.querySelector('.policy-figure figcaption')?.textContent).toBe(s.connection_policy_caption);
    expect(article?.querySelectorAll('.allowed-destinations > div')).toHaveLength(3);
    expect([...article?.querySelectorAll('.allowed-destinations code') ?? []].map(element => element.textContent)).toEqual([
      "'self'", 'http://localhost:*', 'http://127.0.0.1:*',
    ]);
    expect(article?.querySelectorAll('.guide-steps > li')).toHaveLength(3);
    expect(article?.textContent).toContain('Content-Security-Policy');
    expect(article?.textContent).toContain('connect-src');
    expect(article?.querySelector('[data-docs-related-guide] a')?.getAttribute('href')).toBe(`/docs/${locale}/local-ai-servers/`);
  });
});
