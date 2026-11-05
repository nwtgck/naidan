/** Data origins are execution-local evidence, not persisted permissions. */
export type WorkflowValueSource = 'definition' | 'tool_output' | 'model_output' | 'file_input' | 'interactive_input' | 'unknown';

/** Sparse field overrides retain precision without copying a literal JSON tree. */
export type WorkflowValueProvenance = {
  sources: readonly WorkflowValueSource[],
  properties: Readonly<Record<string, WorkflowValueProvenance>>,
};

export function workflowValueOrigin({ source }: { source: WorkflowValueSource }): WorkflowValueProvenance {
  return { sources: [source], properties: {} };
}

export function workflowOriginSources({ origin }: { origin: WorkflowValueProvenance }): WorkflowValueSource[] {
  const sources = new Set<WorkflowValueSource>();
  const seen = new Set<WorkflowValueProvenance>();
  const pending = [origin];
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (current.sources.length === 0) {
      sources.add('unknown');
    }
    for (const source of current.sources) {
      sources.add(source);
    }
    for (const child of Object.values(current.properties)) {
      pending.push(child);
    }
  }
  return [...sources];
}

/** Collapsing is deliberately conservative for transformations and streamed items. */
export function mergeWorkflowOrigins({ origins }: { origins: readonly WorkflowValueProvenance[] }): WorkflowValueProvenance {
  const sources = new Set<WorkflowValueSource>();
  for (const origin of origins) {
    for (const source of workflowOriginSources({ origin })) {
      sources.add(source);
    }
  }
  return { sources: sources.size ? [...sources] : ['definition'], properties: {} };
}

export function workflowFieldOrigin({ origin, key }: { origin: WorkflowValueProvenance, key: string | number }): WorkflowValueProvenance {
  return Object.hasOwn(origin.properties, key) ? origin.properties[String(key)]! : { sources: origin.sources, properties: {} };
}

export function replaceWorkflowOrigin({ origin, path, replacement }: {
  origin: WorkflowValueProvenance, path: readonly (string | number)[], replacement: WorkflowValueProvenance,
}): WorkflowValueProvenance {
  const [key, ...rest] = path;
  if (key === undefined) {
    return replacement;
  }
  const child = workflowFieldOrigin({ origin, key });
  return {
    sources: origin.sources,
    properties: { ...origin.properties, [key]: replaceWorkflowOrigin({ origin: child, path: rest, replacement }) },
  };
}

/** Parameters and prompts are not connection authority; endpoint and model ID are. */
export function workflowTargetSources({ origin }: { origin: WorkflowValueProvenance }): WorkflowValueSource[] {
  return workflowOriginSources({ origin: mergeWorkflowOrigins({ origins: ['endpoint', 'modelId'].map(key => workflowFieldOrigin({ origin, key })) }) });
}

export function isDefinitionWorkflowTarget({ sources }: { sources: readonly WorkflowValueSource[] }): boolean {
  return sources.length > 0 && sources.every(source => source === 'definition');
}

export const TEST_ONLY = {
};
