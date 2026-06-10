export type ApprovalActionId =
  | 'tool.wikipedia.search'
  | 'tool.wikipedia.get_page';

export type ApprovalAction = {
  id: ApprovalActionId;
  label: string;
};

export type ApprovalPreviewLine = {
  label: string;
  value: string;
};

export type ApprovalPreview = {
  lines: ApprovalPreviewLine[];
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
  chatId: string;
  action: ApprovalAction;
  preview: ApprovalPreview | undefined;
  signal: AbortSignal | undefined;
};

export type EnsureApproval = ({
  chatId,
  action,
  preview,
  signal,
}: {
  chatId: string;
  action: ApprovalAction;
  preview: ApprovalPreview | undefined;
  signal: AbortSignal | undefined;
}) => Promise<ApprovalEnsureResult>;

export type ToolApprovalContext = {
  chatId: string;
  ensureApproval: EnsureApproval;
};

export type ApprovalActiveRequest = {
  requestId: string;
  chatId: string;
  action: ApprovalAction;
  preview: ApprovalPreview | undefined;
};

export type ApprovalStoredStatus =
  | 'approved'
  | 'missing';
