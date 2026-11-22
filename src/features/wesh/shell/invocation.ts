import type { WeshShellOption } from '@/features/wesh/types';
import type { ShellSource } from './source';

export type ShellInvocationMode = 'execute' | 'parse-only';

export const SHELL_EXECUTION_OPTION_NAMES = ['allexport', 'errexit', 'nounset', 'pipefail'] as const;

export type WeshExecutionOptions = Record<typeof SHELL_EXECUTION_OPTION_NAMES[number], boolean>;

export function createDefaultExecutionOptions(): WeshExecutionOptions {
  return { allexport: false, errexit: false, nounset: false, pipefail: false };
}

export interface ShellOptionOverride {
  readonly name: WeshShellOption,
  readonly enabled: boolean,
}

export interface ShellInvocation {
  readonly source: ShellSource,
  readonly argv0: string | undefined,
  readonly positionalArgs: readonly string[],
  readonly executionOptions: Readonly<WeshExecutionOptions>,
  readonly shellOptionOverrides: readonly ShellOptionOverride[],
  readonly mode: ShellInvocationMode,
}

export const TEST_ONLY = {
};
