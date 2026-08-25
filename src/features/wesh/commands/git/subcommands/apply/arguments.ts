interface ApplyArguments {
  cached: boolean,
  check: boolean,
  index: boolean,
  reverse: boolean,
  inputPath: string | undefined,
}

export function parseApplyArguments({ args }: { args: readonly string[] }): ApplyArguments {
  let cached = false;
  let check = false;
  let reverse = false;
  let index = false;
  let inputPath: string | undefined;
  let parseOptions = true;
  for (const arg of args) {
    if (parseOptions && arg === '--') {
      parseOptions = false;
      continue;
    }
    if (parseOptions && arg.startsWith('-') && arg !== '-') {
      switch (arg) {
      case '--cached':
        cached = true;
        break;
      case '--check':
        check = true;
        break;
      case '--reverse':
      case '-R':
        reverse = true;
        break;
      case '--index':
        index = true;
        break;
      default:
        throw new Error(`unknown option for git apply: ${arg}`);
      }
      continue;
    }
    if (inputPath !== undefined) throw new Error('git apply accepts at most one patch input');
    inputPath = arg;
  }
  return { cached, check, index, reverse, inputPath };
}

export const TEST_ONLY = {
};
