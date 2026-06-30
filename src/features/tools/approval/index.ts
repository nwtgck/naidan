export { APPROVAL_ACTIONS } from './actions';
export type {
  ApprovalAction,
  ApprovalActionId,
  ApprovalActiveRequest,
  ApprovalEnsureRequest,
  ApprovalEnsureResult,
  ApprovalPreview,
  ApprovalStoredStatus,
  ApprovalUiDecision,
  EnsureApproval,
  ToolApprovalContext,
} from '@/01-models/tool-approval';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
