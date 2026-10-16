import { createDocsLocaleMessagesLoader } from '../../messages/loader';
import type { DocsLocale } from '../../navigation/routes';

type SearchMessages = typeof import('../../messages/search-ui/en').messages;

const loader = createDocsLocaleMessagesLoader<SearchMessages>({
  loaders: {
    en: async () => (await import('../../messages/search-ui/en')).messages,
    ja: async () => (await import('../../messages/search-ui/ja')).messages,
  },
});

export function prepareSearchMessages({ locale }: { locale: DocsLocale }): Promise<SearchMessages> {
  return loader.load({ locale });
}

export function readSearchMessages({ locale }: { locale: DocsLocale }): SearchMessages {
  return loader.read({ locale });
}
