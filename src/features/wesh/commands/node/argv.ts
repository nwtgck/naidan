export const NODE_CHECK_ONLY_ERROR = "node: Wesh supports only JavaScript syntax checking with 'node --check' or 'node -c'; JavaScript execution is disabled";

export type NodeCheckArgvResult =
  | {
      readonly kind: 'check',
      readonly operand: string | undefined,
      readonly scriptArgs: readonly string[],
    }
  | {
      readonly kind: 'unsupported',
    };

function isCheckLongOption({ token }: { token: string }): boolean {
  return token === '--check' || token.startsWith('--check=');
}

/**
 * Recognize only the intentionally supported Node CLI surface.
 *
 * This stays command-local rather than extending argv-v2 because the reference Node CLI
 * rejects clustered short spellings such as `-cc`, while accepting `--check=value` and
 * treating every token after the first script operand as script argv. That asymmetric
 * grammar is not a natural standard-option catalog.
 */
export function parseNodeCheckArgv({
  args,
}: {
  args: readonly string[],
}): NodeCheckArgvResult {
  let checkSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) {
      break;
    }

    if (token === '--') {
      if (!checkSeen) {
        return { kind: 'unsupported' };
      }
      const operand = args[index + 1];
      return {
        kind: 'check',
        operand,
        scriptArgs: operand === undefined ? [] : args.slice(index + 2),
      };
    }

    if (token === '-c' || isCheckLongOption({ token })) {
      checkSeen = true;
      continue;
    }

    if (token === '-' || !token.startsWith('-')) {
      if (!checkSeen) {
        return { kind: 'unsupported' };
      }
      return {
        kind: 'check',
        operand: token,
        scriptArgs: args.slice(index + 1),
      };
    }

    return { kind: 'unsupported' };
  }

  return checkSeen
    ? { kind: 'check', operand: undefined, scriptArgs: [] }
    : { kind: 'unsupported' };
}

export const TEST_ONLY = {
  isCheckLongOption,
};
