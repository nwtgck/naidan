import type { Component } from 'vue';
import type { DocsLocale, DocsPageId } from '../site/routes';
import type { CommonMessages, HomeMessages } from '../site/messages';

export type PageMessages = Pick<HomeMessages, 'title' | 'description'>;
export type RegisteredPage = {
  component: () => Promise<{ default: Component }>;
  messages: Record<DocsLocale, () => Promise<{ strings: PageMessages }>>;
};
export type RenderedPage = {
  body: string;
  title: string;
  description: string;
  locale: DocsLocale;
  page: DocsPageId;
};
export type DocsRenderer = {
  renderPage: ({ locale, page }: { locale: DocsLocale; page: DocsPageId }) => Promise<RenderedPage>;
};
export type PageRegistry = {
  pages: Record<DocsPageId, RegisteredPage>;
  common: Record<DocsLocale, () => Promise<{ strings: CommonMessages }>>;
};
export type PageAssets = { styles: string[]; scripts: string[]; favicon: string };
