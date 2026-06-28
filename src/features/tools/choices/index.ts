import { z } from 'zod';
import type { ChatId } from '@/01-models/ids';
import type { RequestChoice } from '@/features/tools/choices/runtime';
import type {
  Tool,
  ToolExecutionErrorCode,
  ToolExecutionEvent,
} from '@/01-models/tool';
import type { ToolApprovalContext } from '@/features/tools/approval';

const ChoiceSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\r\n]+$/, 'Choices must be single-line text.');

export const ChoicesArgsSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe('Question or instruction shown above the choices.'),
  choices: z
    .array(ChoiceSchema)
    .min(2)
    .max(10)
    .refine(
      (choices) => new Set(choices).size === choices.length,
      'Choices must be unique.',
    )
    .describe('Distinct choices from which the user selects exactly one.'),
});

export type ChoicesArgs = z.infer<typeof ChoicesArgsSchema>;

export function renderChoicesResult({
  index,
  choice,
}: {
  index: number,
  choice: string,
}): string {
  return `\
Selected:
Number: ${index + 1}
${choice}`;
}

export function createChoicesTool({
  chatId,
  requestChoice,
}: {
  chatId: ChatId,
  requestChoice: RequestChoice,
}): Tool {
  return {
    name: 'choices',
    description: `\
Present a prompt and a fixed set of choices in an interactive UI, then wait for the user to select exactly one.

Use this tool when the user should choose from concrete alternatives instead of entering a free-text response.
Provide between 2 and 10 concise, distinct, single-line choices.`,
    parametersSchema: ChoicesArgsSchema,
    async execute({
      args,
      signal,
      onEvent: _onEvent,
      approvalContext: _approvalContext,
    }: {
      args: unknown,
      signal?: AbortSignal,
      onEvent?: ({ event }: { event: ToolExecutionEvent }) => void | Promise<void>,
      approvalContext?: ToolApprovalContext,
    }): Promise<
      | { status: 'success', content: string }
      | { status: 'error', code: ToolExecutionErrorCode, message: string }
    > {
      if (signal?.aborted === true) {
        throw new Error('Generation aborted');
      }

      const parsed = ChoicesArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          status: 'error',
          code: 'invalid_arguments',
          message: `Invalid arguments: ${parsed.error.message}`,
        };
      }

      const selection = await requestChoice({
        chatId,
        prompt: parsed.data.prompt,
        choices: parsed.data.choices,
        signal,
      });
      const choice = parsed.data.choices[selection.index];
      if (choice === undefined) {
        throw new Error(`Choice index is out of range: ${selection.index}`);
      }

      return {
        status: 'success',
        content: renderChoicesResult({
          index: selection.index,
          choice,
        }),
      };
    },
  };
}
