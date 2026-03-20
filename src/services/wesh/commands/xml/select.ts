import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import {
  evaluateXPathNodes,
  evaluateXPathString,
  parseXmlDocument,
  readXmlInputs,
  serializeXmlNode,
} from '@/services/wesh/commands/xml/dom';
import type { WeshCommandContext, WeshCommandResult } from '@/services/wesh/types';

type XmlSelectTemplateAction =
  | { kind: 'value'; expression: string }
  | { kind: 'copy'; expression: string }
  | { kind: 'newline' };

export async function runXmlSelect({
  context,
  args,
}: {
  context: WeshCommandContext;
  args: string[];
}): Promise<WeshCommandResult> {
  const actions: XmlSelectTemplateAction[] = [];
  const inputs: string[] = [];
  let templateMode = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;

    switch (token) {
    case '--help':
      await context.text().print({
        text: `\
Select data from XML documents using XPath.
usage: xml sel -t [-v XPATH | -c XPATH | -n]... [FILE...]
options:
  -t            use template output mode
  -v XPATH      print the string value of an XPath expression
  -c XPATH      copy matching nodes as XML
  -n            print a newline
  --help        display this help and exit
`,
      });
      return { exitCode: 0 };
    case '-t':
      templateMode = true;
      break;
    case '-v': {
      const expression = args[index + 1];
      if (expression === undefined) {
        await writeCommandUsageError({
          context,
          command: 'xml',
          message: 'xml sel: option -v requires an XPath expression',
        });
        return { exitCode: 1 };
      }
      actions.push({ kind: 'value', expression });
      index += 1;
      break;
    }
    case '-c': {
      const expression = args[index + 1];
      if (expression === undefined) {
        await writeCommandUsageError({
          context,
          command: 'xml',
          message: 'xml sel: option -c requires an XPath expression',
        });
        return { exitCode: 1 };
      }
      actions.push({ kind: 'copy', expression });
      index += 1;
      break;
    }
    case '-n':
      actions.push({ kind: 'newline' });
      break;
    default:
      if (token !== '-' && token.startsWith('-')) {
        await writeCommandUsageError({
          context,
          command: 'xml',
          message: `xml sel: unsupported option '${token}'`,
        });
        return { exitCode: 1 };
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
    return { exitCode: 1 };
  }

  if (actions.length === 0) {
    await writeCommandUsageError({
      context,
      command: 'xml',
      message: 'xml sel: at least one template action is required',
    });
    return { exitCode: 1 };
  }

  let hadError = false;
  const sources = await readXmlInputs({
    context,
    inputs,
  }).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    await context.text().error({
      text: `xml sel: ${message}\n`,
    });
    return undefined;
  });

  if (sources === undefined) {
    return { exitCode: 1 };
  }

  for (const source of sources) {
    const parsed = parseXmlDocument({
      xmlText: source.text,
    });
    if (!parsed.ok) {
      await context.text().error({
        text: `xml sel: ${source.label}: ${parsed.message}\n`,
      });
      hadError = true;
      continue;
    }

    let output = '';
    try {
      for (const action of actions) {
        switch (action.kind) {
        case 'value':
          output += evaluateXPathString({
            document: parsed.document,
            expression: action.expression,
            namespaces: new Map(),
          });
          break;
        case 'copy':
          output += evaluateXPathNodes({
            document: parsed.document,
            expression: action.expression,
            namespaces: new Map(),
          }).map((node) => serializeXmlNode({ node })).join('');
          break;
        case 'newline':
          output += '\n';
          break;
        default: {
          const _exhaustive: never = action;
          throw new Error(`Unhandled xml select action: ${_exhaustive}`);
        }
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({
        text: `xml sel: ${source.label}: ${message}\n`,
      });
      hadError = true;
      continue;
    }

    await context.text().print({ text: output });
  }

  return { exitCode: hadError ? 1 : 0 };
}
