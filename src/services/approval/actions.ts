import type { ApprovalAction } from './types';

export const APPROVAL_ACTIONS = {
  toolWikipediaSearch: {
    id: 'tool.wikipedia.search',
    label: 'Search Wikipedia',
  },
  toolWikipediaGetPage: {
    id: 'tool.wikipedia.get_page',
    label: 'Get Wikipedia page',
  },
} as const satisfies Record<string, ApprovalAction>;
