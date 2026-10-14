import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';
import BrowserAiAvailability from '../islands/browser-ai-availability/BrowserAiAvailability.vue';
import { checkerCopy } from '../islands/browser-ai-availability/copy';
import { parseBrowserAiAvailabilityPayload } from '../islands/browser-ai-availability/contracts';
import { checkBrowserAiAvailability } from '../islands/browser-ai-availability/native';
import { findIslands } from '../build/html';
import { parsePage } from './site.test-support';

describe('browser AI availability checker', () => {
  it.each(['available', 'downloadable', 'downloading', 'unavailable'] as const)('checks text input and output without starting a model when the browser returns %s', async availability => {
    const check = vi.fn(async () => availability);
    const create = vi.fn();
    expect(await checkBrowserAiAvailability({ nativeScope: { LanguageModel: { availability: check, create } } })).toBe(availability);
    expect(check).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledWith({ expectedInputs: [{ type: 'text' }], expectedOutputs: [{ type: 'text' }] });
    expect(create).not.toHaveBeenCalled();
  });

  it('separates missing API, unknown native output, and rejected checks', async () => {
    expect(await checkBrowserAiAvailability({ nativeScope: {} })).toBe('apiAbsent');
    expect(await checkBrowserAiAvailability({ nativeScope: { LanguageModel: { availability: async () => 'available' } } })).toBe('apiAbsent');
    expect(await checkBrowserAiAvailability({ nativeScope: { LanguageModel: { availability: async () => 'future-status', create() {} } } })).toBe('unknown');
    expect(await checkBrowserAiAvailability({
      nativeScope: {
        LanguageModel: {
          availability: async () => {
            throw new Error('blocked');
          },
          create() {},
        },
      },
    })).toBe('rejected');
    const nativeScope = {
      get LanguageModel(): never {
        throw new Error('blocked getter');
      },
    };
    expect(await checkBrowserAiAvailability({ nativeScope })).toBe('rejected');
  });

  it.each(['en', 'ja'] as const)('renders a useful %s fallback and validates only the checker copy at the island boundary', async locale => {
    const copy = checkerCopy[locale];
    const html = await renderToString(createSSRApp({ render: () => h(BrowserAiAvailability, { copy }) }));
    using page = parsePage({ html });
    expect(page.document.querySelector('h2')?.textContent).toBe(copy.title);
    expect(page.document.querySelector('[data-testid="browser-ai-availability-status"]')?.textContent).toBe(copy.initial);
    expect(page.document.querySelector('button')?.disabled).toBe(true);
    expect(page.document.body.textContent).toContain(copy.scope);
    const serialized = JSON.stringify({ copy });
    expect(parseBrowserAiAvailabilityPayload({ serialized })).toEqual({ copy });
    expect(findIslands({ body: `<div data-docs-island="browser-ai-availability" data-docs-props='${serialized}'>${html}</div>` })).toEqual(['browser-ai-availability']);
    expect(() => parseBrowserAiAvailabilityPayload({ serialized: JSON.stringify({ copy: { title: copy.title } }) })).toThrow();
  });
});
