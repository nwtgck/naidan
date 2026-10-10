import type { Value } from '../../analysis/values.ts';

export type UrlTarget = { effects: readonly string[], unsupported: string | undefined };

/**
 * A passive image decode is not document/script execution. Unknown strings are
 * not proved HTTP-only. Relative addresses retain both hosted and file-mode
 * candidates instead of treating a leading slash as a local-memory resource.
 * The standard URL parser handles casing, controls and scheme-relative inputs.
 */
export function classifyUrlTarget({ value, use }: { value: Value | undefined, use: 'image' | 'navigation' }): UrlTarget {
  if (value !== undefined) {
    switch (value.kind) {
    case 'choice': {
      const results = value.values.map(item => classifyUrlTarget({ value: item, use }));
      return { effects: [...new Set(results.flatMap(result => result.effects))], unsupported: results.find(result => result.unsupported !== undefined)?.unsupported };
    }
    case 'scalar': case 'native': case 'unknown': case 'record': case 'promise': case 'function': break;
    default: { const exhaustive: never = value; throw new Error(String(exhaustive)); }
    }
  }
  if (value?.kind !== 'scalar' || value.stringEvidence === undefined) {
    return { effects: ['network.http', 'hostfs.read'], unsupported: 'URL scheme/provenance is not verified; string types and casts are not URL evidence.' };
  }
  switch (value.stringEvidence.kind) {
  case 'object-url': {
    switch (use) {
    case 'image': return { effects: [], unsupported: undefined };
    case 'navigation': return { effects: [], unsupported: 'Blob document navigation can execute content; it is not a passive image decode.' };
    default: { const exhaustive: never = use; throw new Error(String(exhaustive)); }
    }
  }
  case 'literal': {
    const effects = new Set<string>();
    let unsupported: string | undefined;
    for (const text of value.stringEvidence.values) {
      const parsed: URL[] = [];
      try {
        parsed.push(new URL(text));
      } catch {
        // No runtime base-state inference. Both supported deployment schemes
        // remain possible, including query/fragment-only relative references.
        for (const base of ['https://naidan.invalid/app/index.html', 'file:///naidan/index.html']) {
          try {
            parsed.push(new URL(text, base));
          } catch {
            unsupported = 'Invalid or deployment-dependent URL cannot be classified.';
          }
        }
      }
      for (const url of parsed) {
        switch (url.protocol) {
        case 'http:': case 'https:': effects.add('network.http'); break;
        case 'file:': effects.add('hostfs.read'); break;
        case 'blob:': case 'data:':
          switch (use) {
          case 'image': break;
          case 'navigation': unsupported = 'Blob/data document navigation can execute content; it is not a passive image decode.'; break;
          default: { const exhaustive: never = use; throw new Error(String(exhaustive)); }
          }
          break;
        default: unsupported = `URL scheme ${url.protocol} is outside this ${use} model.`;
        }
      }
    }
    return { effects: [...effects], unsupported };
  }
  default: { const exhaustive: never = value.stringEvidence; throw new Error(String(exhaustive)); }
  }
}
