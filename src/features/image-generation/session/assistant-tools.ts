import { z } from 'zod';
import { idToRaw } from '@/01-models/ids';
import type { ChatId } from '@/01-models/ids';
import type { Tool, ToolExecutionOutcome } from '@/01-models/tool';
import { applyImageGenerationPromptEdit } from './prompt-access';
import type { ImageGenerationPromptTarget, ImageGenerationPromptEdit } from './prompt-access';

export type ImageGenerationAssistantContext = {
  sessionTitle: string,
  model: string,
  width: number,
  height: number,
  steps: number,
  guidance: number,
  count: number,
};
const readSchema = z.object({}).strict();
// This is the current LM protocol, NOT a persistence schema. Old tool calls
// remain raw transcript data and are never replayed to reconstruct Workspace.
const writeSchema = z.object({
  expectedRevision: z.string().min(1).max(128),
  field: z.enum(['prompt', 'negativePrompt']),
  value: z.string().max(4000),
}).strict();
function failed({ message }: { message: string }): ToolExecutionOutcome {
  return { status: 'error', code: 'execution_failed', message };
}

export function createImageGenerationAssistantTools({ chatId, bindingSignal, readTarget, readContext, commit }: {
  chatId: ChatId,
  bindingSignal: AbortSignal,
  readTarget: () => ImageGenerationPromptTarget | undefined,
  readContext: () => ImageGenerationAssistantContext,
  commit: ({ expected, edit }: { expected: ImageGenerationPromptTarget, edit: ImageGenerationPromptEdit }) => 'applied' | 'conflict',
}): Tool[] {
  const lifetime = new AbortController();
  function signalFor({ signal }: { signal: AbortSignal | undefined }): AbortSignal {
    return AbortSignal.any([bindingSignal, lifetime.signal, ...(signal ? [signal] : [])]);
  }
  const read: Tool = {
    name: 'image_generation_get_context',
    description: 'Read the connected Image Generation draft to translate or improve its prompt. Returns a revision needed by image_generation_set_prompt. No image generation, network requests or model-file reads are performed. The draft can change; read again before editing.',
    parametersSchema: readSchema,
    async dispose() {
      lifetime.abort();
    },
    async execute({ args, signal, approvalContext }) {
      if (!readSchema.safeParse(args).success) return { status: 'error', code: 'invalid_arguments', message: 'Expected an empty object.' };
      if (signalFor({ signal }).aborted) return failed({ message: 'The Workspace connection or this turn has ended.' });
      if (approvalContext?.chatId !== chatId) return failed({ message: 'The tool belongs to a different or unavailable chat.' });
      const target = readTarget();
      if (!target || target.chatId !== chatId) return failed({ message: 'The connected Workspace draft is not available for editing.' });
      return { status: 'success', content: JSON.stringify({ ...readContext(), prompt: target.prompt, negativePrompt: target.negativePrompt, revision: idToRaw({ id: target.revision }) }) };
    },
  };
  const write: Tool = {
    name: 'image_generation_set_prompt',
    description: 'Propose replacing the positive or negative prompt in the connected Image Generation. Use the exact revision from image_generation_get_context. Naidan asks for permission and rejects stale edits. Changes only the draft; never starts image generation or changes models, seeds or sampling settings.',
    parametersSchema: writeSchema,
    async dispose() {
      lifetime.abort();
    },
    async execute({ args, signal, approvalContext }) {
      const parsed = writeSchema.safeParse(args);
      if (!parsed.success) return { status: 'error', code: 'invalid_arguments', message: parsed.error.message };
      if (approvalContext?.chatId !== chatId) return failed({ message: 'A matching chat approval context is required.' });
      const target = readTarget();
      if (!target || target.chatId !== chatId || idToRaw({ id: target.revision }) !== parsed.data.expectedRevision) return failed({ message: 'The draft changed or the connection ended. Read the context again; do not overwrite a newer draft.' });
      const { field, value } = parsed.data;
      try {
        const outcome = await applyImageGenerationPromptEdit({
          target,
          edit: { field, value },
          signal: signalFor({ signal }),
          readTarget,
          commit,
          ensureApproval: ({ change, signal }) => approvalContext.ensureApproval({
            chatId,
            action: { id: 'tool.image_generation.set_prompt', label: 'Edit Image Generation prompt' },
            preview: { type: 'image_generation_prompt', field: change.field, before: change.before, after: change.after },
            signal,
          }),
        });
        switch (outcome.status) {
        case 'applied': return { status: 'success', content: 'Prompt draft updated. No image generation was started.' };
        case 'denied': return failed({ message: 'The user denied this edit. Do not retry without a new instruction.' });
        case 'invalid_arguments': return { status: 'error', code: 'invalid_arguments', message: 'The proposed prompt is invalid.' };
        case 'stale': case 'unavailable': case 'cancelled': return failed({ message: `Edit not applied: ${outcome.status}. The draft or connection changed.` });
        default: { const exhaustive: never = outcome; throw new Error(String(exhaustive)); }
        }
      } catch (error) {
        return failed({ message: error instanceof Error ? error.message : String(error) });
      }
    },
  };
  return [read, write];
}
export const TEST_ONLY = {
};
