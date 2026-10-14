import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import RpcPage from '../pages/endpoint-type-naidan-rpc/index.vue';
import { strings as rpcEn } from '../pages/endpoint-type-naidan-rpc/strings/en';
import { strings as rpcJa } from '../pages/endpoint-type-naidan-rpc/strings/ja';
import { strings as commonEn } from '../strings/common/en';
import { strings as commonJa } from '../strings/common/ja';
import { parsePage } from './site.test-support';
import { visibleGuideText } from './ui-label.test-support';

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
    expect(launch?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/');
    expect(launch?.textContent).toBe('Naidan');
    expect(launch?.querySelector('[data-docs-external-icon], .sr-only')).toBeNull();
    expect(article?.querySelector('.app-entry-intro')?.textContent).toBe(`${copy.launch.before}Naidan${copy.launch.after}`);
    const hostedExample = article?.querySelector('.hosted-example');
    expect(hostedExample?.textContent).toContain(copy.hostedExample.body);
    expect(hostedExample?.querySelector('[data-docs-external]')?.getAttribute('href')).toBe('https://naidan.pages.dev/');
    expect(hostedExample?.querySelector('[data-docs-external-icon]')).toBeTruthy();
    expect(hostedExample?.nextElementSibling?.getAttribute('data-testid')).toBe('rpc-guide-step');
    expect([...article?.querySelectorAll('[data-testid="rpc-guide-step"] > h2') ?? []].map(heading => heading.textContent)).toEqual([
      copy.steps.enable.title, copy.steps.pair.title, copy.steps.verify.title, copy.steps.provide.title, copy.steps.use.title,
    ]);
    expect([...article?.querySelectorAll('[data-docs-animation]') ?? []].map(scene => scene.getAttribute('data-docs-animation'))).toEqual([
      'rpc-enable', 'rpc-pair', 'rpc-verify', 'rpc-provide', 'rpc-use',
    ]);
    expect(article?.querySelector('[data-testid="rpc-step-pair"]')?.textContent).toContain(copy.demo.codeSample);
    expect(article?.querySelector('[data-testid="rpc-step-pair"]')?.textContent).toContain(copy.demo.serverSample);
    const relay = article?.querySelector('.relay-origin');
    expect(relay?.querySelector('code')?.textContent).toBe(copy.demo.serverSample);
    expect(relay?.querySelector('[data-docs-external]')?.getAttribute('href')).toBe('https://github.com/nwtgck/piping-server#public-servers');
    expect(relay?.querySelector('[data-docs-external-icon]')).toBeTruthy();
    expect(article?.querySelector('[data-testid="rpc-step-verify"]')?.textContent).toContain(copy.demo.comparison);
    expect(article?.querySelector('[data-testid="rpc-step-verify"]')?.textContent).toContain(copy.demo.remember);
    expect(article?.querySelector('[data-testid="rpc-step-provide"]')?.textContent).toContain(copy.demo.apply);
    expect(article?.querySelector('[data-testid="rpc-step-use"]')?.textContent).toContain(copy.demo.model);
    expect(article?.textContent).toContain(visibleGuideText({ text: copy.image }));
    expect(article?.textContent).toContain(visibleGuideText({ text: copy.boundary }));
    expect(article?.querySelector('[data-docs-related-guide] a')?.getAttribute('href')).toBe(`/docs/${locale}/endpoint-type-llama-cpp-browser/`);
    expect(article?.querySelectorAll('figure button, figure input, figure select, figure a')).toHaveLength(0);
  });
});
