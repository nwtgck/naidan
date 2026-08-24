import { writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import {
  evaluateXPathBooleanWithContext,
  evaluateXPathNodes,
  evaluateXPathString,
  evaluateXPathValueStrings,
  parseXmlDocument,
  readXmlInputs,
  serializeXmlNode,
  XmlRuntimeEvaluationError,
} from '@/features/wesh/commands/xml/dom';
import type { WeshCommandContext, WeshCommandResult } from '@/features/wesh/types';

function escapeXmlText({ text }: { text: string }): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

type XmlSelectConditionalBranch =
  | { kind: 'if'; expression: string; actions: XmlSelectTemplateAction[] }
  | { kind: 'else'; actions: XmlSelectTemplateAction[] };

type XmlSelectConditionalAction = {
  kind: 'conditional';
  branches: XmlSelectConditionalBranch[];
};

type XmlSelectTemplateAction =
  | { kind: 'value'; expression: string }
  | { kind: 'copy'; expression: string }
  | { kind: 'output'; value: string }
  | { kind: 'input-name' }
  | { kind: 'newline' }
  | { kind: 'match'; expression: string; actions: XmlSelectTemplateAction[] }
  | XmlSelectConditionalAction;

type XmlSelectActionScope =
  | { kind: 'root'; actions: XmlSelectTemplateAction[] }
  | { kind: 'match'; actions: XmlSelectTemplateAction[] }
  | { kind: 'conditional'; action: XmlSelectConditionalAction; actions: XmlSelectTemplateAction[] };

function renderText({
  value,
  textOutput,
}: {
  value: string;
  textOutput: boolean;
}): string {
  return textOutput ? value : escapeXmlText({ text: value });
}

function appendOutput({
  output,
  value,
}: {
  output: string[] | undefined;
  value: string;
}): boolean {
  output?.push(value);
  return value.length > 0;
}

function renderActions({
  actions,
  document,
  contextNode,
  contextPosition,
  contextSize,
  namespaces,
  sourceLabel,
  textOutput,
  output,
}: {
  actions: readonly XmlSelectTemplateAction[];
  document: Document;
  contextNode: Node | undefined;
  contextPosition: number;
  contextSize: number;
  namespaces: Map<string, string>;
  sourceLabel: string;
  textOutput: boolean;
  output: string[] | undefined;
}): boolean {
  type ActionFrame = {
    readonly actions: readonly XmlSelectTemplateAction[],
    readonly nextIndex: number,
    readonly contextNode: Node | undefined,
    readonly contextPosition: number,
    readonly contextSize: number,
  };

  const pending: ActionFrame[] = [{
    actions,
    nextIndex: 0,
    contextNode,
    contextPosition,
    contextSize,
  }];
  let producedOutput = false;

  while (pending.length > 0) {
    const frame = pending.pop()!;
    const action = frame.actions[frame.nextIndex];
    if (action === undefined) continue;
    pending.push({ ...frame, nextIndex: frame.nextIndex + 1 });

    switch (action.kind) {
    case 'value': {
      const values = evaluateXPathValueStrings({
        document,
        expression: action.expression,
        namespaces,
        contextNode: frame.contextNode,
        contextPosition: frame.contextPosition,
        contextSize: frame.contextSize,
      });
      const rendered = values
        .map((value) => renderText({ value, textOutput }))
        .join('\n');
      producedOutput = appendOutput({ output, value: rendered }) || producedOutput;
      break;
    }
    case 'copy': {
      const nodes = evaluateXPathNodes({
        document,
        expression: action.expression,
        namespaces,
        contextNode: frame.contextNode,
      });
      producedOutput = nodes.length > 0 || producedOutput;
      if (nodes.some((node) => node.nodeType === Node.ATTRIBUTE_NODE)) {
        throw new XmlRuntimeEvaluationError('Cannot add an attribute node to a non-element node.');
      }
      if (output !== undefined) {
        for (const node of nodes) {
          const value = (() => {
            if (!textOutput) return serializeXmlNode({ node });
            if (
              node.nodeType === Node.COMMENT_NODE
              || node.nodeType === Node.PROCESSING_INSTRUCTION_NODE
            ) {
              return '';
            }
            return evaluateXPathString({
              document,
              expression: '.',
              namespaces,
              contextNode: node,
            });
          })();
          producedOutput = appendOutput({ output, value }) || producedOutput;
        }
      }
      break;
    }
    case 'output':
      producedOutput = appendOutput({
        output,
        value: renderText({ value: action.value, textOutput }),
      }) || producedOutput;
      break;
    case 'input-name':
      producedOutput = appendOutput({
        output,
        value: renderText({ value: sourceLabel, textOutput }),
      }) || producedOutput;
      break;
    case 'newline':
      producedOutput = appendOutput({ output, value: '\n' }) || producedOutput;
      break;
    case 'match': {
      const nodes = evaluateXPathNodes({
        document,
        expression: action.expression,
        namespaces,
        contextNode: frame.contextNode,
      });
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        pending.push({
          actions: action.actions,
          nextIndex: 0,
          contextNode: nodes[index],
          contextPosition: index + 1,
          contextSize: nodes.length,
        });
      }
      break;
    }
    case 'conditional': {
      for (const branch of action.branches) {
        const matches = (() => {
          switch (branch.kind) {
          case 'if':
            return evaluateXPathBooleanWithContext({
              document,
              expression: branch.expression,
              namespaces,
              contextNode: frame.contextNode,
              contextPosition: frame.contextPosition,
              contextSize: frame.contextSize,
            });
          case 'else':
            return true;
          default: {
            const _exhaustive: never = branch;
            throw new Error(`Unhandled XML conditional branch: ${String(_exhaustive)}`);
          }
          }
        })();
        if (!matches) continue;
        pending.push({
          actions: branch.actions,
          nextIndex: 0,
          contextNode: frame.contextNode,
          contextPosition: frame.contextPosition,
          contextSize: frame.contextSize,
        });
        break;
      }
      break;
    }
    default: {
      const _exhaustive: never = action;
      throw new Error(`Unhandled xml select action: ${String(_exhaustive)}`);
    }
    }
  }
  return producedOutput;
}

async function writeMissingOptionValue({
  context,
  option,
  valueName,
}: {
  context: WeshCommandContext;
  option: string;
  valueName: string;
}): Promise<WeshCommandResult> {
  await writeCommandUsageError({
    context,
    command: 'xml',
    message: `xml sel: option ${option} requires ${valueName}`,
  });
  return { exitCode: 2 };
}

export async function runXmlSelect({
  context,
  args,
}: {
  context: WeshCommandContext;
  args: string[];
}): Promise<WeshCommandResult> {
  const rootActions: XmlSelectTemplateAction[] = [];
  const actionStack: XmlSelectActionScope[] = [{ kind: 'root', actions: rootActions }];
  const inputs: string[] = [];
  const namespaces = new Map<string, string>();
  let templateMode = false;
  let textOutput = false;
  let quiet = false;

  const currentScope = (): XmlSelectActionScope => {
    const scope = actionStack.at(-1);
    if (scope === undefined) {
      throw new Error('xml select action stack is empty');
    }
    return scope;
  };

  const currentActions = (): XmlSelectTemplateAction[] => currentScope().actions;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    if (templateMode && inputs.length > 0) {
      inputs.push(token);
      continue;
    }

    switch (token) {
    case '--help':
      await context.text().print({
        text: `\
Select data from XML documents using XPath.
usage: xml sel [GLOBAL-OPTION]... -t [ACTION]... [FILE...]
global options:
  -Q, --quiet         suppress normal output
  -T, --text          output text without XML escaping
  -N PREFIX=URI       bind an XPath namespace prefix
markup actions:
  -t, --template      use template output mode
  -m, --match XPATH   evaluate nested actions for each matching node
  -i, --if XPATH      evaluate nested actions when the expression is true
  --elif XPATH        start a fallback conditional branch
  --else              start the final conditional branch
  -v, --value-of XPATH
                      print the string value of an XPath expression
  -c, --copy-of XPATH copy matching nodes as XML
  -o, --output TEXT   print literal text
  -f, --inp-name      print the input file name
  -n, --nl            print a newline
  -b, --break         close the innermost match
  --help              display this help and exit
`,
      });
      return { exitCode: 0 };
    case '-Q':
    case '--quiet':
      if (templateMode) {
        await writeCommandUsageError({
          context,
          command: 'xml',
          message: `xml sel: unsupported option '${token}'`,
        });
        return { exitCode: 2 };
      }
      quiet = true;
      break;
    case '-T':
    case '--text':
      if (templateMode) {
        await writeCommandUsageError({
          context,
          command: 'xml',
          message: `xml sel: unsupported option '${token}'`,
        });
        return { exitCode: 2 };
      }
      textOutput = true;
      break;
    case '-N': {
      if (templateMode) {
        await writeCommandUsageError({
          context,
          command: 'xml',
          message: `xml sel: unsupported option '${token}'`,
        });
        return { exitCode: 2 };
      }
      const binding = args[index + 1];
      if (binding === undefined) {
        return await writeMissingOptionValue({
          context,
          option: token,
          valueName: 'PREFIX=URI',
        });
      }
      const separator = binding.indexOf('=');
      if (separator <= 0) {
        await writeCommandUsageError({
          context,
          command: 'xml',
          message: `xml sel: invalid namespace binding '${binding}'`,
        });
        return { exitCode: 2 };
      }
      const prefix = binding.slice(0, separator);
      if (!namespaces.has(prefix)) {
        namespaces.set(prefix, binding.slice(separator + 1));
      }
      index += 1;
      break;
    }
    case '-t':
    case '--template':
      templateMode = true;
      actionStack.splice(1);
      break;
    case '-m':
    case '--match': {
      const expression = args[index + 1];
      if (expression === undefined) {
        return await writeMissingOptionValue({ context, option: token, valueName: 'an XPath expression' });
      }
      const action: XmlSelectTemplateAction = { kind: 'match', expression, actions: [] };
      currentActions().push(action);
      actionStack.push({ kind: 'match', actions: action.actions });
      index += 1;
      break;
    }
    case '-i':
    case '--if': {
      const expression = args[index + 1];
      if (expression === undefined) {
        return await writeMissingOptionValue({ context, option: token, valueName: 'an XPath expression' });
      }
      const branch: XmlSelectConditionalBranch = { kind: 'if', expression, actions: [] };
      const action: XmlSelectConditionalAction = { kind: 'conditional', branches: [branch] };
      currentActions().push(action);
      actionStack.push({ kind: 'conditional', action, actions: branch.actions });
      index += 1;
      break;
    }
    case '--elif': {
      const expression = args[index + 1];
      if (expression === undefined) {
        return await writeMissingOptionValue({ context, option: token, valueName: 'an XPath expression' });
      }
      const scope = currentScope();
      switch (scope.kind) {
      case 'conditional':
        break;
      case 'root':
      case 'match':
        await writeCommandUsageError({
          context,
          command: 'xml',
          message: 'xml sel: elif without an open if branch',
        });
        return { exitCode: 2 };
      default: {
        const _exhaustive: never = scope;
        throw new Error(`Unhandled XML action scope: ${String(
          ((_exhaustive satisfies never) as { readonly kind: string }).kind,
        )}`);
      }
      }
      if (scope.action.branches.some((branch) => branch.kind === 'else')) {
        return { exitCode: 1 };
      }
      const branch: XmlSelectConditionalBranch = { kind: 'if', expression, actions: [] };
      scope.action.branches.push(branch);
      scope.actions = branch.actions;
      index += 1;
      break;
    }
    case '--else': {
      const scope = currentScope();
      switch (scope.kind) {
      case 'conditional':
        break;
      case 'root':
      case 'match':
        await writeCommandUsageError({
          context,
          command: 'xml',
          message: 'xml sel: else without an open if branch',
        });
        return { exitCode: 2 };
      default: {
        const _exhaustive: never = scope;
        throw new Error(`Unhandled XML action scope: ${String(
          ((_exhaustive satisfies never) as { readonly kind: string }).kind,
        )}`);
      }
      }
      if (scope.action.branches.some((branch) => branch.kind === 'else')) {
        return { exitCode: 1 };
      }
      const branch: XmlSelectConditionalBranch = { kind: 'else', actions: [] };
      scope.action.branches.push(branch);
      scope.actions = branch.actions;
      break;
    }
    case '-v':
    case '--value-of': {
      const expression = args[index + 1];
      if (expression === undefined) {
        return await writeMissingOptionValue({ context, option: token, valueName: 'an XPath expression' });
      }
      currentActions().push({ kind: 'value', expression });
      index += 1;
      break;
    }
    case '-c':
    case '--copy-of': {
      const expression = args[index + 1];
      if (expression === undefined) {
        return await writeMissingOptionValue({ context, option: token, valueName: 'an XPath expression' });
      }
      currentActions().push({ kind: 'copy', expression });
      index += 1;
      break;
    }
    case '-o':
    case '--output': {
      const value = args[index + 1];
      if (value === undefined) {
        return await writeMissingOptionValue({ context, option: token, valueName: 'text' });
      }
      currentActions().push({ kind: 'output', value });
      index += 1;
      break;
    }
    case '-f':
    case '--inp-name':
      currentActions().push({ kind: 'input-name' });
      break;
    case '-n':
    case '--nl':
      currentActions().push({ kind: 'newline' });
      break;
    case '-b':
    case '--break':
      if (actionStack.length === 1) {
        return { exitCode: 1 };
      }
      actionStack.pop();
      break;
    default:
      if (token !== '-' && token.startsWith('-')) {
        await writeCommandUsageError({
          context,
          command: 'xml',
          message: `xml sel: unsupported option '${token}'`,
        });
        return { exitCode: 2 };
      }
      inputs.push(token);
      break;
    }
  }

  if (!templateMode) {
    await writeCommandUsageError({
      context,
      command: 'xml',
      message: 'xml sel: template mode (-t) is required',
    });
    return { exitCode: 2 };
  }

  if (rootActions.length === 0) {
    await writeCommandUsageError({
      context,
      command: 'xml',
      message: 'xml sel: at least one template action is required',
    });
    return { exitCode: 2 };
  }

  let failureExitCode = 0;
  let producedOutput = false;
  let sourceIndex = 0;
  const quietBatch = quiet && inputs.length > 1;
  for await (const source of readXmlInputs({ context, inputs })) {
    const isFirstSource = sourceIndex === 0;
    sourceIndex += 1;
    if (!source.ok) {
      if (!quietBatch || isFirstSource) {
        await context.text().error({
          text: `xml sel: ${source.label}: ${source.message}\n`,
        });
      }
      if (!quietBatch) failureExitCode = Math.max(failureExitCode, 3);
      continue;
    }

    const parsed = parseXmlDocument({
      xmlText: source.text,
    });
    if (!parsed.ok) {
      if (!quietBatch || isFirstSource) {
        await context.text().error({
          text: `xml sel: ${source.label}: ${parsed.message}\n`,
        });
      }
      if (!quietBatch) failureExitCode = Math.max(failureExitCode, 3);
      continue;
    }

    const output = quiet ? undefined : [];
    try {
      producedOutput = renderActions({
        actions: rootActions,
        document: parsed.document,
        contextNode: undefined,
        contextPosition: 1,
        contextSize: 1,
        namespaces,
        sourceLabel: source.label,
        textOutput,
        output,
      }) || producedOutput;
    } catch (error: unknown) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = rawMessage.length > 0 ? rawMessage : 'invalid XPath expression';
      await context.text().error({
        text: `xml sel: ${source.label}: ${message}\n`,
      });
      failureExitCode = Math.max(
        failureExitCode,
        quiet && error instanceof XmlRuntimeEvaluationError ? 1 : 4,
      );
      continue;
    }

    if (output !== undefined) {
      await context.text().print({ text: output.join('') });
    }
  }

  return { exitCode: Math.max(failureExitCode, producedOutput ? 0 : 1) };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
