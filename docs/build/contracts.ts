import type { Component } from 'vue';
import type { DocsLocale, DocsPageId } from '../site/routes';
import type { CommonMessages } from '../site/messages';

export type PageMessages = { title: string; description: string; intro: string[] };
export type RegisteredPage = {
  component: Component;
  messages: Record<DocsLocale, PageMessages>;
};
export type RenderedPage = {
  body: string;
  title: string;
  description: string;
  locale: DocsLocale;
  page: DocsPageId;
};
export type DocsRenderer = {
  renderPage: (args: { locale: DocsLocale; page: DocsPageId }) => Promise<RenderedPage>;
};
export type PageRegistry = {
  pages: Record<DocsPageId, RegisteredPage>;
  common: Record<DocsLocale, CommonMessages>;
};
export type PageAssets = { styles: string[]; scripts: string[] };
