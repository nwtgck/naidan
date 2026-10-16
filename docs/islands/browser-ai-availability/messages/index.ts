import { createDocsLocaleMessagesLoader } from '../../../messages/loader';
import type { DocsLocale } from '../../../navigation/routes';

type BrowserAiMessages = typeof import('./en').messages;

const loader = createDocsLocaleMessagesLoader<BrowserAiMessages>({
  loaders: {
    en: async () => (await import('./en')).messages,
    ja: async () => (await import('./ja')).messages,
  },
});

export function prepareBrowserAiMessages({ locale }: { locale: DocsLocale }): Promise<BrowserAiMessages> {
  return loader.load({ locale });
}

export function readBrowserAiMessages({ locale }: { locale: DocsLocale }): BrowserAiMessages {
  return loader.read({ locale });
}
