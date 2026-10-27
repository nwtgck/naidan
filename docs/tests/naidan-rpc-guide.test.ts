import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import RpcPage from '../pages/endpoint-type-naidan-rpc/index.vue';
import { messages as rpcEn } from '../pages/endpoint-type-naidan-rpc/messages/en';
import { messages as rpcJa } from '../pages/endpoint-type-naidan-rpc/messages/ja';
import { messages as commonEn } from '../messages/common/en';
import { messages as commonJa } from '../messages/common/ja';
import { parsePage } from './site.test-support';

describe('Naidan RPC guide', () => {
  it.each([
    { locale: 'en' as const, copy: rpcEn, common: commonEn },
    { locale: 'ja' as const, copy: rpcJa, common: commonJa },
  ])('renders the verified pair-to-chat workflow and the image option in $locale', async ({ locale, copy, common }) => {
    const html = await renderToString(createSSRApp(RpcPage, { s: copy, locale, common }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-models-naidan-rpc"]');
    expect(article?.querySelector('h1')?.textContent).toBe(copy.title);
    const launch = article?.querySelector<HTMLAnchorElement>('.app-entry-intro a[data-docs-app-entry-path]');
    expect(launch?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/settings/connection');
    expect(launch?.textContent).toBe('/#/settings/connection');
    expect(launch?.querySelector('[data-docs-external-icon], .sr-only')).toBeNull();
    expect(article?.querySelector('.app-entry-intro')?.textContent).toContain('/#/settings/connection');
    const hostedExample = article?.querySelector('.hosted-example');
    expect(hostedExample?.textContent).toContain(locale === 'en' ? 'The device providing a model' : 'モデルを提供する端末');
    expect(hostedExample?.querySelector('[data-docs-external]')?.getAttribute('href')).toBe('https://naidan.pages.dev/');
    expect(hostedExample?.querySelector('[data-docs-external-icon]')).toBeTruthy();
    expect(hostedExample?.nextElementSibling?.getAttribute('data-testid')).toBe('rpc-guide-step');
    expect([...article?.querySelectorAll('[data-testid="rpc-guide-step"] > h2') ?? []].map(heading => heading.textContent)).toEqual([
      copy.enable_peer_connection_heading, copy.pair_browsers_heading, copy.verify_peer_heading, copy.grant_peer_methods_heading, copy.select_peer_for_chat_heading,
    ]);
    expect([...article?.querySelectorAll('[data-docs-animation]') ?? []].map(scene => scene.getAttribute('data-docs-animation'))).toEqual([
      'rpc-enable', 'rpc-pair', 'rpc-verify', 'rpc-provide', 'rpc-use',
    ]);
    expect(article?.querySelector('[data-testid="rpc-step-pair"]')?.textContent).toContain(copy.sample_meeting_code);
    expect(article?.querySelector('[data-testid="rpc-step-pair"]')?.textContent).toContain(copy.sample_relay_origin);
    expect(article?.querySelector('#rpc-pair')?.parentElement?.textContent).toContain(copy.use_the_current_version_on_both_devices);
    const relay = article?.querySelector('.relay-origin');
    expect(relay?.querySelector('code')?.textContent).toBe(copy.sample_relay_origin);
    expect(relay?.querySelector('[data-docs-external]')?.getAttribute('href')).toBe('https://github.com/nwtgck/piping-server#public-servers');
    expect(relay?.querySelector('[data-docs-external-icon]')).toBeTruthy();
    expect(article?.querySelector('[data-testid="rpc-step-verify"]')?.textContent).toContain(copy.sample_verification_text);
    expect(article?.querySelector('[data-testid="rpc-step-verify"]')?.textContent).toContain(copy.remember_peer_trust);
    expect(article?.querySelector('[data-testid="rpc-step-provide"]')?.textContent).toContain(copy.apply_provided_methods);
    expect(article?.querySelector('[data-testid="rpc-step-use"]')?.textContent).toContain(copy.sample_peer_model);
    expect(article?.querySelector('.rpc-note .ui-label')?.textContent).toBe(locale === 'en' ? 'Components' : '構成');
    expect(article?.textContent).toContain(copy.peer_data_boundary);
    expect(article?.querySelector('[data-docs-related-guide] a')?.getAttribute('href')).toBe(`/docs/${locale}/endpoint-type-llama-cpp-browser/`);
    expect(article?.querySelectorAll('figure button, figure input, figure select, figure a')).toHaveLength(0);
  });
});
