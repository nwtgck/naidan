import type { Diagnostic } from '@/features/llama-cpp-browser/debug-log';
import type { ModelExecution } from './model-execution-schema';

/** An old or incomplete observation is unknown, never assumed to be native. */
export function observedModelExecution({ summary }: { summary: Diagnostic | undefined }): ModelExecution | undefined {
  const outer = summary?.modelExecution, inner = summary?.performance?.modelExecution;
  if (outer && inner && modelExecutionIdentity({ execution: outer }) !== modelExecutionIdentity({ execution: inner })) {
    return undefined;
  }
  return inner ?? outer;
}

/** Labels and local registration IDs do not change the mathematical program. */
export function modelExecutionIdentity({ execution }: { execution: ModelExecution | undefined }): string {
  if (!execution) {
    return 'unobserved';
  }
  switch (execution.kind) {
  case 'nativeArchitecture': return 'nativeArchitecture';
  case 'registeredModelGraph': {
    const { kind, architecture, format, definitionSha256, nativeExtensionSha256, label: _label, registrationId: _registrationId, ...rest } = execution;
    rest satisfies Record<PropertyKey, never>;
    return JSON.stringify({ kind, architecture, format, definitionSha256, nativeExtensionSha256 });
  }
  default: {
    const exhaustive: never = execution;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
