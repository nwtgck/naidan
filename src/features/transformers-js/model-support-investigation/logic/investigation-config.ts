export type ModelSupportInvestigationPreset = 'full' | 'offline' | 'download-focused' | 'custom';

export type ModelSupportInvestigationExternalNetworkPolicy = 'allow' | 'deny';

export type ModelSupportInvestigationScopeId =
  | 'repository-download'
  | 'model-load'
  | 'generation'
  | 'continuity'
  | 'capability-probes';

export type ModelSupportInvestigationScopeSelection = 'selected' | 'not-selected';
export type ModelSupportInvestigationEffectiveScopeState = 'selected' | 'required' | 'not-selected';

export type ModelSupportInvestigationScope = Record<
  ModelSupportInvestigationScopeId,
  ModelSupportInvestigationScopeSelection
>;

export interface ModelSupportInvestigationConfiguration {
  scope: ModelSupportInvestigationScope;
  externalNetworkPolicy: ModelSupportInvestigationExternalNetworkPolicy;
}

export interface ModelSupportInvestigationExecutionPlan {
  repositoryDownload: boolean;
  modelLoad: boolean;
  generation: boolean;
  continuity: boolean;
  capabilityProbes: boolean;
}

export interface ModelSupportInvestigationTargetParseError {
  lineNumber: number;
  input: string;
  reason: 'invalid-model-id';
}

export interface ModelSupportInvestigationTargetParseResult {
  targets: string[];
  errors: ModelSupportInvestigationTargetParseError[];
}

const FULL_SCOPE: ModelSupportInvestigationScope = {
  'repository-download': 'selected',
  'model-load': 'selected',
  'generation': 'selected',
  'continuity': 'selected',
  'capability-probes': 'selected',
};

const DOWNLOAD_FOCUSED_SCOPE: ModelSupportInvestigationScope = {
  'repository-download': 'selected',
  'model-load': 'not-selected',
  'generation': 'not-selected',
  'continuity': 'not-selected',
  'capability-probes': 'not-selected',
};

export function createDefaultInvestigationConfiguration(): ModelSupportInvestigationConfiguration {
  return {
    scope: { ...FULL_SCOPE },
    externalNetworkPolicy: 'allow',
  };
}

export function configurationForPreset({ preset }: {
  preset: Exclude<ModelSupportInvestigationPreset, 'custom'>;
}): ModelSupportInvestigationConfiguration {
  switch (preset) {
  case 'full':
    return { scope: { ...FULL_SCOPE }, externalNetworkPolicy: 'allow' };
  case 'offline':
    return { scope: { ...FULL_SCOPE }, externalNetworkPolicy: 'deny' };
  case 'download-focused':
    return { scope: { ...DOWNLOAD_FOCUSED_SCOPE }, externalNetworkPolicy: 'allow' };
  default: {
    const _ex: never = preset;
    return _ex;
  }
  }
}

function scopeMatches({ left, right }: {
  left: ModelSupportInvestigationScope;
  right: ModelSupportInvestigationScope;
}): boolean {
  const ids: ModelSupportInvestigationScopeId[] = [
    'repository-download',
    'model-load',
    'generation',
    'continuity',
    'capability-probes',
  ];
  return ids.every(id => left[id] === right[id]);
}

export function deriveInvestigationPreset({ configuration }: {
  configuration: ModelSupportInvestigationConfiguration;
}): ModelSupportInvestigationPreset {
  if (scopeMatches({ left: configuration.scope, right: FULL_SCOPE })) {
    switch (configuration.externalNetworkPolicy) {
    case 'allow':
      return 'full';
    case 'deny':
      return 'offline';
    default: {
      const _ex: never = configuration.externalNetworkPolicy;
      return _ex;
    }
    }
  }
  if (scopeMatches({ left: configuration.scope, right: DOWNLOAD_FOCUSED_SCOPE })) {
    return 'download-focused';
  }
  return 'custom';
}

function requiresModelLoad({ scope }: { scope: ModelSupportInvestigationScope }): boolean {
  return scope.generation === 'selected'
    || scope.continuity === 'selected'
    || scope['capability-probes'] === 'selected';
}

function requiresGeneration({ scope }: { scope: ModelSupportInvestigationScope }): boolean {
  return scope.continuity === 'selected' || scope['capability-probes'] === 'selected';
}

function effectiveScopeState({ selection, required }: {
  selection: ModelSupportInvestigationScopeSelection,
  required: boolean,
}): ModelSupportInvestigationEffectiveScopeState {
  switch (selection) {
  case 'selected':
    return 'selected';
  case 'not-selected':
    return required ? 'required' : 'not-selected';
  default: {
    const _ex: never = selection;
    return _ex;
  }
  }
}

function scopeStateEnabled({ state }: {
  state: ModelSupportInvestigationEffectiveScopeState,
}): boolean {
  switch (state) {
  case 'selected':
  case 'required':
    return true;
  case 'not-selected':
    return false;
  default: {
    const _ex: never = state;
    return _ex;
  }
  }
}

export function resolveEffectiveScope({ scope }: {
  scope: ModelSupportInvestigationScope;
}): Record<ModelSupportInvestigationScopeId, ModelSupportInvestigationEffectiveScopeState> {
  const modelLoadRequired = requiresModelLoad({ scope });
  const generationRequired = requiresGeneration({ scope });

  return {
    'repository-download': effectiveScopeState({ selection: scope['repository-download'], required: false }),
    'model-load': effectiveScopeState({ selection: scope['model-load'], required: modelLoadRequired }),
    'generation': effectiveScopeState({ selection: scope.generation, required: generationRequired }),
    'continuity': effectiveScopeState({ selection: scope.continuity, required: false }),
    'capability-probes': effectiveScopeState({ selection: scope['capability-probes'], required: false }),
  };
}

export function resolveInvestigationExecutionPlan({ scope }: {
  scope: ModelSupportInvestigationScope;
}): ModelSupportInvestigationExecutionPlan {
  const effective = resolveEffectiveScope({ scope });
  return {
    repositoryDownload: scopeStateEnabled({ state: effective['repository-download'] }),
    modelLoad: scopeStateEnabled({ state: effective['model-load'] }),
    generation: scopeStateEnabled({ state: effective.generation }),
    continuity: scopeStateEnabled({ state: effective.continuity }),
    capabilityProbes: scopeStateEnabled({ state: effective['capability-probes'] }),
  };
}

function stripKnownHostPrefix({ input }: { input: string }): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('hf.co/')) return trimmed.slice('hf.co/'.length);
  if (trimmed.startsWith('huggingface.co/')) return trimmed.slice('huggingface.co/'.length);
  return trimmed;
}

function normalizeUrlTarget({ input }: { input: string }): string | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (url.hostname !== 'hf.co' && url.hostname !== 'huggingface.co') return undefined;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return undefined;
  try {
    return `${decodeURIComponent(parts[0]!)}/${decodeURIComponent(parts[1]!)}`;
  } catch {
    return undefined;
  }
}

function validCanonicalModelId({ input }: { input: string }): boolean {
  const parts = input.split('/');
  if (parts.length !== 2) return false;
  return parts.every(part => (
    part.length > 0
    && part !== '.'
    && part !== '..'
    && !/[\s?#]/u.test(part)
  ));
}

export function normalizeInvestigationTarget({ input }: { input: string }): string | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  const fromUrl = normalizeUrlTarget({ input: trimmed });
  if (fromUrl !== undefined) return validCanonicalModelId({ input: fromUrl }) ? fromUrl : undefined;
  const canonical = stripKnownHostPrefix({ input: trimmed }).replace(/\/$/u, '');
  return validCanonicalModelId({ input: canonical }) ? canonical : undefined;
}

export function parseInvestigationTargets({ text }: { text: string }): ModelSupportInvestigationTargetParseResult {
  const targets: string[] = [];
  const errors: ModelSupportInvestigationTargetParseError[] = [];
  const seen = new Set<string>();

  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const normalized = normalizeInvestigationTarget({ input: line });
    if (normalized === undefined) {
      errors.push({ lineNumber, input: rawLine, reason: 'invalid-model-id' });
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    targets.push(normalized);
  }

  return { targets, errors };
}

export function canonicalInvestigationTargetList({ targets }: { targets: readonly string[] }): string {
  const normalized = parseInvestigationTargets({ text: targets.join('\n') });
  return normalized.targets.join('\n');
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  DOWNLOAD_FOCUSED_SCOPE,
  FULL_SCOPE,
};
