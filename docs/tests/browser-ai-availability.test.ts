import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';
import BrowserAiAvailability from '../islands/browser-ai-availability/BrowserAiAvailability.vue';
import { prepareBrowserAiMessages, readBrowserAiMessages } from '../islands/browser-ai-availability/messages';
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

  it.each(['en', 'ja'] as const)('renders a useful %s fallback from island messages and validates the locale-only payload', async locale => {
    await prepareBrowserAiMessages({ locale });
    const messages = readBrowserAiMessages({ locale });
    const html = await renderToString(createSSRApp({ render: () => h(BrowserAiAvailability, { locale }) }));
    using page = parsePage({ html });
    expect(page.document.querySelector('h2')?.textContent).toBe(messages.check_this_browser_heading);
    expect(page.document.querySelector('[data-testid="browser-ai-availability-status"]')?.textContent).toBe(messages.not_checked_yet);
    expect(page.document.querySelector('button')?.disabled).toBe(true);
    expect(page.document.body.textContent).toContain(messages.browser_scope);
    const serialized = JSON.stringify({ locale });
    expect(parseBrowserAiAvailabilityPayload({ serialized })).toEqual({ locale });
    expect(findIslands({ body: `<div data-docs-island="browser-ai-availability" data-docs-props='${serialized}'>${html}</div>` })).toEqual(['browser-ai-availability']);
    expect(() => parseBrowserAiAvailabilityPayload({ serialized: JSON.stringify({ locale: 'fr' }) })).toThrow();
    expect(() => parseBrowserAiAvailabilityPayload({ serialized: JSON.stringify({ locale, copy: messages }) })).toThrow();
  });
});
