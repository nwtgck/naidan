import type { DiagnosticsQueryConfig } from './query-parameters';

export type DiagnosticsModelSelection =
  | { kind: 'default' }
  | { kind: 'all' }
  | { kind: 'explicit', ids: string[] };

export function diagnosticsModelSelection({ config }: { config: DiagnosticsQueryConfig }): DiagnosticsModelSelection {
  return config.allModels ? { kind: 'all' } : config.modelIds !== undefined
    ? { kind: 'explicit', ids: [...config.modelIds] } : { kind: 'default' };
}

export function resolveDiagnosticsModels({ selection, ids, defaultModel }: {
  selection: DiagnosticsModelSelection, ids: string[], defaultModel: string | undefined,
}): string[] {
  switch (selection.kind) {
  case 'all': return [...new Set(ids)].sort();
  case 'explicit': return [...selection.ids]; // Missing IDs stay visible and block starting.
  case 'default': return defaultModel !== undefined && ids.includes(defaultModel) ? [defaultModel] : [];
  default: {
    const exhaustive: never = selection;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
