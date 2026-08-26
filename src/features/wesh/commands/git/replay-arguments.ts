import type { GitReplayAction } from './replay-operation';

type GitReplayControlAction = Exclude<GitReplayAction, 'start'>;

export function parseReplayControlAction({ args }: {
  args: readonly string[];
}): GitReplayControlAction | undefined {
  let action: GitReplayControlAction | undefined;
  let hasUnsupportedArgument = false;
  for (const arg of args) {
    let nextAction: GitReplayControlAction | undefined;
    switch (arg) {
    case '--continue':
      nextAction = 'continue';
      break;
    case '--abort':
      nextAction = 'abort';
      break;
    case '--skip':
      nextAction = 'skip';
      break;
    case '--no-edit':
      continue;
    default:
      hasUnsupportedArgument = true;
      continue;
    }
    if (action !== undefined && action !== nextAction)
      throw new Error(`options '--${action}' and '${arg}' cannot be used together`);
    action = nextAction;
  }
  if (action !== undefined && hasUnsupportedArgument)
    throw new Error(`options cannot be combined with '--${action}'`);
  return action;
}

export const TEST_ONLY = {
};
