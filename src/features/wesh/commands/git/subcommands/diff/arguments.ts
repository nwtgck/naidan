export interface GitDiffArguments {
  cached: boolean,
  nameOnly: boolean,
  nameStatus: boolean,
  stat: boolean,
  check: boolean,
  quiet: boolean,
  exitCode: boolean,
  nul: boolean,
  revisions: readonly string[],
  pathOperands: readonly string[],
}

export function parseDiffArguments({ args }: { args: readonly string[] }): GitDiffArguments {
  let cached = false;
  let nameOnly = false;
  let nameStatus = false;
  let stat = false;
  let check = false;
  let quiet = false;
  let exitCode = false;
  let nul = false;
  const revisions: string[] = [];
  const pathOperands: string[] = [];
  let parsingPaths = false;
  for (const arg of args) {
    if (parsingPaths) {
      pathOperands.push(arg);
      continue;
    }
    switch (arg) {
    case '--':
      parsingPaths = true;
      break;
    case '--cached':
    case '--staged':
      cached = true;
      break;
    case '--name-only':
      nameOnly = true;
      break;
    case '--name-status':
      nameStatus = true;
      break;
    case '--stat':
      stat = true;
      break;
    case '--check':
      check = true;
      break;
    case '--quiet':
      quiet = true;
      exitCode = true;
      break;
    case '--exit-code':
      exitCode = true;
      break;
    case '-z':
      nul = true;
      break;
    case '--cc':
    case '--no-color':
    case '--no-ext-diff':
      break;
    default:
      if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
      revisions.push(arg);
      break;
    }
  }
  if (cached && revisions.length > 1) throw new Error('too many revisions for --cached');
  if (!cached && revisions.length > 2) throw new Error('too many revisions');
  return { cached, nameOnly, nameStatus, stat, check, quiet, exitCode, nul, revisions, pathOperands };
}

export const TEST_ONLY = {
};
