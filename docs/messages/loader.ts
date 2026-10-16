import type { DocsLocale } from '../navigation/routes';

export function createDocsLocaleMessagesLoader<Messages extends object>({ loaders }: {
  loaders: Record<DocsLocale, () => Promise<Messages>>;
}): {
  load: ({ locale }: { locale: DocsLocale }) => Promise<Messages>;
  read: ({ locale }: { locale: DocsLocale }) => Messages;
} {
  const ready = new Map<DocsLocale, Messages>();
  const pending = new Map<DocsLocale, Promise<Messages>>();

  return {
    load: ({ locale }) => {
      const loaded = ready.get(locale);
      if (loaded !== undefined) {
        return Promise.resolve(loaded);
      }
      const inFlight = pending.get(locale);
      if (inFlight) {
        return inFlight;
      }
      const next = Promise.resolve().then(() => loaders[locale]()).then(messages => {
        ready.set(locale, messages);
        return messages;
      }).finally(() => {
        pending.delete(locale);
      });
      pending.set(locale, next);
      return next;
    },
    read: ({ locale }) => {
      const messages = ready.get(locale);
      if (messages === undefined) {
        throw new Error(`Docs messages for ${locale} were read before loading`);
      }
      return messages;
    },
  };
}
