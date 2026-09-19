import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';
import { NODE_CHECK_ONLY_ERROR, parseNodeCheckArgv } from './argv';
import { renderNodeSyntaxDiagnostic } from './diagnostic';
import { resolveNodeSyntaxInput } from './input';
import { checkNodeSyntax } from './parser';

async function writeError({
  context,
  text,
}: {
  context: WeshCommandContext,
  text: string,
}): Promise<void> {
  await context.text().error({ text: text.endsWith('\n') ? text : `${text}\n` });
}

async function executeNodeCheck({
  context,
}: {
  context: WeshCommandContext,
}): Promise<WeshCommandResult> {
  const argv = parseNodeCheckArgv({ args: context.args });
  switch (argv.kind) {
  case 'unsupported':
    await writeError({ context, text: NODE_CHECK_ONLY_ERROR });
    return { exitCode: 1 };
  case 'check':
    break;
  default: {
    const _ex: never = argv;
    throw new Error(`Unhandled node argv result: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
  }
  }

  const resolved = await resolveNodeSyntaxInput({ context, operand: argv.operand });
  switch (resolved.kind) {
  case 'error':
    await writeError({ context, text: resolved.message });
    return { exitCode: 1 };
  case 'source':
    break;
  default: {
    const _ex: never = resolved;
    throw new Error(`Unhandled node input result: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
  }
  }

  const result = checkNodeSyntax({ input: resolved.input });
  switch (result.kind) {
  case 'ok':
    return { exitCode: 0 };
  case 'error':
    await writeError({
      context,
      text: renderNodeSyntaxDiagnostic({
        source: resolved.input.source,
        displayName: resolved.input.displayName,
        diagnostic: result.diagnostic,
      }),
    });
    return { exitCode: 1 };
  default: {
    const _ex: never = result;
    throw new Error(`Unhandled node parser result: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
  }
  }
}

export const nodeCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => executeNodeCheck({ context }),
};

export const TEST_ONLY = {
  writeError,
  executeNodeCheck,
};
