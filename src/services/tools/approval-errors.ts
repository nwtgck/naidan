import type { ApprovalAction } from '@/services/approval';
import type { ToolExecutionErrorCode } from './types';

export function createApprovalDeniedToolError({
  action,
}: {
  action: ApprovalAction;
}): {
  status: 'error';
  code: ToolExecutionErrorCode;
  message: string;
} {
  return {
    status: 'error',
    code: 'other',
    message: `User denied approval for ${action.label}.`,
  };
}

export function createMissingApprovalContextToolError({
  action,
}: {
  action: ApprovalAction;
}): {
  status: 'error';
  code: ToolExecutionErrorCode;
  message: string;
} {
  return {
    status: 'error',
    code: 'other',
    message: `Approval is required for ${action.label}, but approval context is unavailable.`,
  };
}
