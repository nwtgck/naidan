import type { UiLocale } from '@/01-models/ui-locale';

export function formatSearchUpdated({ lastModified, now, locale }: { lastModified: string, now: number, locale: UiLocale }): { label: string, title: string, datetime: string } | undefined {
  const timestamp = Date.parse(lastModified);
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) {
    return undefined;
  }
  const date = new Date(timestamp);
  const days = Math.floor((now - timestamp) / 86_400_000);
  const label = days >= 0 && days < 7
    ? new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-days, 'day')
    : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: date.getFullYear() !== new Date(now).getFullYear() ? 'numeric' : undefined }).format(date);
  return { label, title: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'long' }).format(date), datetime: date.toISOString() };
}

export const TEST_ONLY = {
};
