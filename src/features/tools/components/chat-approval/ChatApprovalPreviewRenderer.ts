import { h, type VNode } from 'vue';
import type { ApprovalPreview } from '@/features/tools/approval';
import WikipediaGetPageApprovalPreview from './previews/WikipediaGetPageApprovalPreview.vue';
import WikipediaSearchApprovalPreview from './previews/WikipediaSearchApprovalPreview.vue';

export default function ChatApprovalPreviewRenderer({
  preview,
}: {
  preview: ApprovalPreview,
}): VNode {
  switch (preview.type) {
  case 'wikipedia_search':
    return h(WikipediaSearchApprovalPreview, {
      keyword: preview.keyword,
    });
  case 'wikipedia_get_page':
    return h(WikipediaGetPageApprovalPreview, {
      title: preview.title,
      pageId: preview.pageId,
    });
  default: {
    const _exhaustive: never = preview;
    throw new Error(`Unhandled approval preview type: ${JSON.stringify(_exhaustive)}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
