import type { WeshShellOption } from '@/features/wesh/types';
import type { ShellSource } from './source';

export type ShellInvocationMode = 'execute' | 'parse-only';

export interface ShellExecutionOptions {
  readonly errexit: boolean,
  readonly nounset: boolean,
  readonly pipefail: boolean,
}

export interface ShellOptionOverride {
  readonly name: WeshShellOption,
  readonly enabled: boolean,
}

export interface ShellInvocation {
  readonly source: ShellSource,
  readonly argv0: string,
  readonly positionalArgs: readonly string[],
  readonly executionOptions: ShellExecutionOptions,
  readonly shellOptionOverrides: readonly ShellOptionOverride[],
  readonly mode: ShellInvocationMode,
}

export const TEST_ONLY = {
};
