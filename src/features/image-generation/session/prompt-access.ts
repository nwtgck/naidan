import { z } from 'zod';
import type { ChatId, ImageGenerationBindingId, ImageGenerationDraftRevisionId, ImageGenerationSessionId, ImageGenerationStoreId } from '@/01-models/ids';
import type { ApprovalEnsureResult } from '@/01-models/tool-approval';
import { parametersSchema } from '@/features/stable-diffusion-cpp-browser/types';

/** Ephemeral capability identity, never saved in a tool transcript as Workspace state. */
export type ImageGenerationPromptTarget = {
  storeId: ImageGenerationStoreId,
  sessionId: ImageGenerationSessionId,
  bindingId: ImageGenerationBindingId,
  chatId: ChatId,
  revision: ImageGenerationDraftRevisionId,
  prompt: string,
  negativePrompt: string,
};
export type ImageGenerationPromptEdit =
  | { field: 'prompt', value: string }
  | { field: 'negativePrompt', value: string };

export type ImageGenerationPromptChange = {
  field: ImageGenerationPromptEdit['field'],
  before: string,
  after: string,
};
export type ImageGenerationPromptEditOutcome =
  | { status: 'applied' }
  | { status: 'denied' }
  | { status: 'unavailable' }
  | { status: 'stale' }
  | { status: 'cancelled' }
  | { status: 'invalid_arguments' };

const editSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('prompt'), value: parametersSchema.shape.prompt }).strict(),
  z.object({ field: z.literal('negativePrompt'), value: parametersSchema.shape.negativePrompt }).strict(),
]);

function checkTarget({ current, accepted }: {
  current: ImageGenerationPromptTarget | undefined, accepted: ImageGenerationPromptTarget,
}): 'current' | 'unavailable' | 'stale' {
  if (!current || current.storeId !== accepted.storeId || current.sessionId !== accepted.sessionId
    || current.bindingId !== accepted.bindingId || current.chatId !== accepted.chatId) return 'unavailable';
  // The controller must issue a fresh revision for model/input/settings changes,
  // manual edits and undo/redo, even when the prompt happens to become identical.
  if (current.revision !== accepted.revision || current.prompt !== accepted.prompt || current.negativePrompt !== accepted.negativePrompt) return 'stale';
  return 'current';
}

/** target is captured by the trusted, chat-scoped tool adapter, not selected from
 * model-supplied IDs. The adapter supplies ordinary Naidan approval. This function does
 * not own permission grants, parse historical JSON, generate images or save a
 * draft. readTarget and commit must address the same explicit editor instance.
 * commit is synchronous and must compare-and-set the whole accepted identity;
 * it must also issue a fresh revision. Never substitute whichever editor is active.
 */
export async function applyImageGenerationPromptEdit({ target, edit, signal, readTarget, ensureApproval, commit }: {
  target: ImageGenerationPromptTarget,
  edit: unknown,
  signal: AbortSignal | undefined,
  readTarget: () => ImageGenerationPromptTarget | undefined,
  ensureApproval: ({ chatId, change, signal }: { chatId: ChatId, change: ImageGenerationPromptChange, signal: AbortSignal | undefined }) => Promise<ApprovalEnsureResult>,
  commit: ({ expected, edit }: { expected: ImageGenerationPromptTarget, edit: ImageGenerationPromptEdit }) => 'applied' | 'conflict',
}): Promise<ImageGenerationPromptEditOutcome> {
  // Callers and approval presenters may hold mutable objects. Capture all values
  // before yielding, and never expose the accepted snapshot to those callbacks.
  const accepted = { ...target };
  const parsed = editSchema.safeParse(edit);
  if (!parsed.success) return { status: 'invalid_arguments' };
  const acceptedEdit = parsed.data;
  function available(): 'current' | 'unavailable' | 'stale' | 'cancelled' {
    if (signal?.aborted) return 'cancelled';
    return checkTarget({ current: readTarget(), accepted });
  }
  const beforeApproval = available();
  switch (beforeApproval) {
  case 'current': break;
  case 'unavailable': case 'stale': case 'cancelled': return { status: beforeApproval };
  default: { const exhaustive: never = beforeApproval; throw new Error(String(exhaustive)); }
  }
  const approval = await ensureApproval({
    chatId: accepted.chatId,
    change: {
    field: acceptedEdit.field,
    before: accepted[acceptedEdit.field],
    after: acceptedEdit.value,
  },
    signal,
  });
  // This check also runs for a previously stored allow-for-chat/global grant.
  // Approval gives a capability, not permission to overwrite a newer draft.
  const afterApproval = available();
  switch (afterApproval) {
  case 'current': break;
  case 'unavailable': case 'stale': case 'cancelled': return { status: afterApproval };
  default: { const exhaustive: never = afterApproval; throw new Error(String(exhaustive)); }
  }
  switch (approval.status) {
  case 'denied': return { status: 'denied' };
  case 'approved': break;
  default: { const exhaustive: never = approval; throw new Error(String(exhaustive)); }
  }
  const committed = commit({ expected: { ...accepted }, edit: { ...acceptedEdit } });
  switch (committed) {
  case 'applied': return { status: 'applied' };
  case 'conflict': return { status: 'stale' };
  default: { const exhaustive: never = committed; throw new Error(String(exhaustive)); }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
