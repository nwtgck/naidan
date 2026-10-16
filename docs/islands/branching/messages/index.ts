import { createDocsLocaleMessagesLoader } from '../../../messages/loader';

export type BranchingMessages = typeof import('./en').messages;
export type BranchingChrome = typeof import('./en').chrome;
type BranchingResources = { messages: BranchingMessages; chrome: BranchingChrome };

const loader = createDocsLocaleMessagesLoader<BranchingResources>({
  loaders: {
    en: async () => {
      const { messages, chrome } = await import('./en');
      return { messages, chrome };
    },
    ja: async () => {
      const { messages, chrome } = await import('./ja');
      return { messages, chrome };
    },
  },
});

export const prepareBranchingMessages = loader.load;
export const readBranchingMessages = loader.read;
