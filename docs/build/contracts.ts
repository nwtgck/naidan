import type { Component } from 'vue';
import type { DocsLocale, DocsPageId } from '../navigation/routes';
import type { CommonMessages, HomeMessages } from '../messages/types';

export type PageMessages = Pick<HomeMessages, 'title' | 'description'>;
export type RegisteredPage = {
  component: () => Promise<{ default: Component }>;
  messages: Record<DocsLocale, () => Promise<{ messages: PageMessages }>>;
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
  common: Record<DocsLocale, () => Promise<{ messages: CommonMessages }>>;
};
export type PageAssets = { styles: string[]; scripts: string[]; favicon: string };
