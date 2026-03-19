import { parseStandardArgv } from './standard-parser';
import type { ParsedSubcommandArgv, SubcommandArgvParserSpec } from './types';

export function parseSubcommandArgv({
  args,
  spec,
}: {
  args: string[];
  spec: SubcommandArgvParserSpec;
}): ParsedSubcommandArgv {
  const matchedSubcommands: string[] = [];
  let activeSpec = spec;
  let index = 0;

  while (index < args.length) {
    const token = args[index];
    if (token === undefined) break;
    const nextSpec = activeSpec.subcommands[token];
    if (nextSpec === undefined) break;
    matchedSubcommands.push(token);
    activeSpec = nextSpec;
    index += 1;
  }

  if (activeSpec.parser.kind === 'subcommand') {
    const nested = parseSubcommandArgv({
      args: args.slice(index),
      spec: activeSpec.parser.spec,
    });
    return {
      matchedSubcommands: [...matchedSubcommands, ...nested.matchedSubcommands],
      activeCommand: nested.activeCommand,
      parsed: nested.parsed,
    };
  }

  return {
    matchedSubcommands,
    activeCommand: activeSpec.name,
    parsed: parseStandardArgv({
      args: args.slice(index),
      spec: activeSpec.parser.spec,
    }),
  };
}
