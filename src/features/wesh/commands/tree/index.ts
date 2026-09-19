import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { parseTreeArgv, treeArgvSpec } from './argv';
import { createTreeOutputWriter } from './output';
import {
  buildTreeForOperand,
  createTreeSummary,
  renderTreeNode,
  resolveTreeOperand,
  writeTreeReport,
} from './traversal';
import type { TreeTraversalState } from './types';

async function runTree({
  context,
}: {
  context: WeshCommandContext,
}): Promise<WeshCommandResult> {
  const parsed = parseTreeArgv({ args: context.args });
  switch (parsed.kind) {
  case 'help':
    await writeCommandHelp({
      context,
      command: 'tree',
      argvSpec: treeArgvSpec,
    });
    return { exitCode: 0 };
  case 'version':
    await context.text().print({ text: 'wesh tree 1.0\n' });
    return { exitCode: 0 };
  case 'error':
    await writeCommandUsageError({
      context,
      command: 'tree',
      message: parsed.message,
      argvSpec: treeArgvSpec,
    });
    return { exitCode: 1 };
  case 'run':
    break;
  default: {
    const _ex: never = parsed;
    throw new Error(`Unhandled tree argv result: ${JSON.stringify(_ex)}`);
  }
  }

  let writer;
  try {
    writer = await createTreeOutputWriter({
      context,
      outputPath: parsed.options.outputPath,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await context.text().error({ text: `tree: ${message}\n` });
    return { exitCode: 2 };
  }

  let exitCode = 0;
  try {
    const summary = createTreeSummary();
    const state: TreeTraversalState = {
      context,
      options: parsed.options,
      summary,
    };

    let wroteOperand = false;
    for (let index = 0; index < parsed.paths.length; index += 1) {
      const operand = parsed.paths[index];
      if (operand === undefined) {
        continue;
      }
      try {
        const resolvedOperand = await resolveTreeOperand({
          context,
          operand,
          options: parsed.options,
        });
        const node = await buildTreeForOperand({
          state,
          operand: resolvedOperand,
        });
        if (node !== undefined) {
          if (wroteOperand) {
            await writer.write({ text: '\n' });
          }
          wroteOperand = true;
          await renderTreeNode({
            node,
            options: parsed.options,
            writer,
            ancestorHasMoreSiblings: [],
            isRoot: true,
            isLast: true,
          });
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await context.text().error({ text: `tree: ${operand}: ${message}\n` });
        exitCode = 2;
      }
    }

    if (summary.traversalErrors > 0) {
      exitCode = 2;
    }
    await writeTreeReport({
      writer,
      summary,
      options: parsed.options,
    });
    await writer.close();
    return { exitCode };
  } catch (error: unknown) {
    await writer.abort({ reason: error });
    const message = error instanceof Error ? error.message : String(error);
    await context.text().error({ text: `tree: ${message}\n` });
    return { exitCode: 2 };
  }
}

export const treeCommandImplementation: WeshCommandImplementation = {
  fn: runTree,
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
