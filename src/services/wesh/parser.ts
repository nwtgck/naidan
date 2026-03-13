export interface Redirection {
  type: '>' | '>>' | '<' | '2>' | '2>&1';
  target: string | undefined;
}

export interface ParsedCommand {
  command: string;
  args: string[];
  redirections: Redirection[];
}

export interface Pipeline {
  commands: ParsedCommand[];
}

export function parseCommandLine({
  commandLine,
  env,
}: {
  commandLine: string;
  env: Record<string, string>;
}): Pipeline {
  const pipeParts = commandLine.split('|').map((p) => p.trim());
  const commands: ParsedCommand[] = [];

  for (const part of pipeParts) {
    const rawTokens = splitArguments({ text: part });
    const tokens = rawTokens.map((t) => expandVariables({ text: t, env }));

    if (tokens.length === 0) continue;

    const args: string[] = [];
    const redirections: Redirection[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === undefined) continue;

      if (token === '>' || token === '>>' || token === '<' || token === '2>') {
        const type = token as '>' | '>>' | '<' | '2>';
        const target = tokens[++i];
        redirections.push({ type, target });
      } else if (token === '2>&1') {
        redirections.push({ type: '2>&1', target: undefined });
      } else {
        args.push(token);
      }
    }

    if (args.length === 0) continue;

    const command = args[0]!;
    const cmdArgs = args.slice(1);

    commands.push({ command, args: cmdArgs, redirections });
  }

  return { commands };
}

function splitArguments({ text }: { text: string }): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes: string | null = null;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (inQuotes) {
      if (char === inQuotes) inQuotes = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      inQuotes = char;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function expandVariables({ text, env }: { text: string; env: Record<string, string> }): string {
  return text.replace(/\$(\w+)|\${(\w+)}|\$\?/g, (match, p1, p2) => {
    if (match === '$?') return env['?'] || '0';
    const key = p1 || p2;
    if (key === 'RANDOM') return Math.floor(Math.random() * 32768).toString();
    return env[key || ''] || '';
  });
}
