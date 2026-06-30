import type { WeshWorkerCommandEntry, WeshWorkerDirectoryEntry } from '@/features/wesh/worker/types';

export type WeshTerminalCompletionCandidateKind = 'command' | 'file' | 'directory';

export interface WeshTerminalCompletionCandidate {
  value: string,
  display: string,
  kind: WeshTerminalCompletionCandidateKind,
}

export interface WeshTerminalCompletionResult {
  replacement: {
    start: number,
    end: number,
    text: string,
  } | undefined,
  candidates: WeshTerminalCompletionCandidate[],
}

export interface WeshTerminalCompletionToken {
  start: number,
  end: number,
  text: string,
  role: 'command' | 'path',
}

// Terminal completion intentionally lives outside Wesh core. Wesh is primarily
// a command execution environment for LM tool calls; this terminal layer is an
// experimental UI for humans inspecting Wesh behavior. The lightweight token
// handling here may duplicate a small amount of shell-like logic, but it does
// not affect command execution semantics and can be promoted later if it proves
// generally useful.
export function getTerminalCompletionToken({
  line,
  cursor,
}: {
  line: string,
  cursor: number,
}): WeshTerminalCompletionToken {
  const boundedCursor = Math.max(0, Math.min(cursor, line.length));
  let start = boundedCursor;
  while (start > 0 && !/\s/u.test(line[start - 1] ?? '')) {
    start -= 1;
  }

  const prefixBeforeToken = line.slice(0, start);
  return {
    start,
    end: boundedCursor,
    text: line.slice(start, boundedCursor),
    role: prefixBeforeToken.trim().length === 0 ? 'command' : 'path',
  };
}

export function completeCommandToken({
  token,
  commands,
}: {
  token: WeshTerminalCompletionToken,
  commands: WeshWorkerCommandEntry[],
}): WeshTerminalCompletionResult {
  const candidates = commands
    .filter(command => command.name.startsWith(token.text))
    .map((command): WeshTerminalCompletionCandidate => ({
      value: command.name,
      display: formatCommandCandidateDisplay({ command }),
      kind: 'command',
    }))
    .sort((left, right) => left.value.localeCompare(right.value));

  return buildReplacementResult({ token, candidates, appendSpaceForSingleCommand: true });
}


function formatCommandCandidateDisplay({ command }: { command: WeshWorkerCommandEntry }): string {
  switch (command.kind) {
  case 'alias':
    return `${command.name} -> ${command.usage}`;
  case 'builtin':
    return command.name;
  default: {
    const _ex: never = command.kind;
    return _ex;
  }
  }
}

function buildPathCandidate({
  prefix,
  entry,
}: {
  prefix: string,
  entry: WeshWorkerDirectoryEntry,
}): WeshTerminalCompletionCandidate {
  switch (entry.type) {
  case 'directory':
    return {
      value: `${prefix}${entry.name}/`,
      display: `${entry.name}/`,
      kind: 'directory',
    };
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    return {
      value: `${prefix}${entry.name}`,
      display: entry.name,
      kind: 'file',
    };
  default: {
    const _ex: never = entry.type;
    return _ex;
  }
  }
}

export function splitPathToken({ tokenText }: { tokenText: string }): {
  directoryPath: string,
  prefix: string,
  basenamePrefix: string,
} {
  const slashIndex = tokenText.lastIndexOf('/');
  if (slashIndex < 0) {
    return {
      directoryPath: '.',
      prefix: '',
      basenamePrefix: tokenText,
    };
  }

  const prefix = tokenText.slice(0, slashIndex + 1);
  return {
    directoryPath: prefix.length === 0 ? '/' : prefix,
    prefix,
    basenamePrefix: tokenText.slice(slashIndex + 1),
  };
}

export function completePathToken({
  token,
  entries,
}: {
  token: WeshTerminalCompletionToken,
  entries: WeshWorkerDirectoryEntry[],
}): WeshTerminalCompletionResult {
  const { prefix, basenamePrefix } = splitPathToken({ tokenText: token.text });
  const candidates = entries
    .filter(entry => entry.name.startsWith(basenamePrefix))
    .map((entry): WeshTerminalCompletionCandidate => buildPathCandidate({ prefix, entry }))
    .sort((left, right) => left.value.localeCompare(right.value));

  return buildReplacementResult({ token, candidates, appendSpaceForSingleCommand: false });
}

function buildReplacementResult({
  token,
  candidates,
  appendSpaceForSingleCommand,
}: {
  token: WeshTerminalCompletionToken,
  candidates: WeshTerminalCompletionCandidate[],
  appendSpaceForSingleCommand: boolean,
}): WeshTerminalCompletionResult {
  if (candidates.length === 0) {
    return { replacement: undefined, candidates };
  }

  if (candidates.length === 1) {
    const candidate = candidates[0];
    if (candidate === undefined) {
      return { replacement: undefined, candidates };
    }
    return {
      replacement: {
        start: token.start,
        end: token.end,
        text: appendSpaceForSingleCommand && candidate.kind === 'command' ? `${candidate.value} ` : candidate.value,
      },
      candidates,
    };
  }

  const commonPrefix = findCommonPrefix({ values: candidates.map(candidate => candidate.value) });
  if (commonPrefix.length > token.text.length) {
    return {
      replacement: {
        start: token.start,
        end: token.end,
        text: commonPrefix,
      },
      candidates,
    };
  }

  return { replacement: undefined, candidates };
}

function findCommonPrefix({ values }: { values: string[] }): string {
  const first = values[0];
  if (first === undefined) return '';

  let end = first.length;
  for (const value of values.slice(1)) {
    while (end > 0 && value.slice(0, end) !== first.slice(0, end)) {
      end -= 1;
    }
  }
  return first.slice(0, end);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
