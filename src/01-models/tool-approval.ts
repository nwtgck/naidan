import type { ChatId, ToolApprovalRequestId } from '@/01-models/ids';

export type ApprovalActionId =
  | 'tool.wikipedia.search'
  | 'tool.wikipedia.get_page';

export type ApprovalAction = {
  id: ApprovalActionId,
  label: string,
};

export type ApprovalPreview =
  | {
      type: 'wikipedia_search',
      keyword: string,
    }
  | {
      type: 'wikipedia_get_page',
      title: string | undefined,
      pageId: string,
    };

export type ApprovalUiDecision =
  | 'allow_once'
  | 'allow_for_chat'
  | 'allow_globally'
  | 'deny';

export type ApprovalEnsureResult =
  | { status: 'approved' }
  | { status: 'denied' };

export type ApprovalEnsureRequest = {
  chatId: ChatId,
  action: ApprovalAction,
  preview: ApprovalPreview | undefined,
  signal: AbortSignal | undefined,
};

export type EnsureApproval = ({
  chatId,
  action,
  preview,
  signal,
}: {
  chatId: ChatId,
  action: ApprovalAction,
  preview: ApprovalPreview | undefined,
  signal: AbortSignal | undefined,
}) => Promise<ApprovalEnsureResult>;

export type ToolApprovalContext = {
  chatId: ChatId,
  ensureApproval: EnsureApproval,
};

export type ApprovalActiveRequest = {
  requestId: ToolApprovalRequestId,
  chatId: ChatId,
  action: ApprovalAction,
  preview: ApprovalPreview | undefined,
};

export type ApprovalStoredStatus =
  | 'approved'
  | 'missing';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
