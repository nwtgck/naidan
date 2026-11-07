import { describe, expect, it } from 'vitest';
import type { WorkflowValueProvenance } from './provenance';
import { workflowValueOrigin, workflowFieldOrigin, workflowOriginSources, replaceWorkflowOrigin, mergeWorkflowOrigins, workflowTargetSources, isDefinitionWorkflowTarget } from './provenance';

describe('Workflow value origin projection', () => {
  it('retains sparse child evidence through nested projections and ignores unrelated fields', () => {
    const fixed = workflowValueOrigin({ source: 'definition' });
    const dynamic = workflowValueOrigin({ source: 'model_output' });
    const origin = replaceWorkflowOrigin({ origin: fixed, path: ['payload', 'lmParameters', 'temperature'], replacement: dynamic });
    const payload = workflowFieldOrigin({ origin, key: 'payload' });
    expect(isDefinitionWorkflowTarget({ sources: workflowTargetSources({ origin: payload }) })).toBe(true);
    const changed = replaceWorkflowOrigin({ origin, path: ['payload', 'endpoint', 'url'], replacement: dynamic });
    expect(workflowTargetSources({ origin: workflowFieldOrigin({ origin: changed, key: 'payload' }) })).toContain('model_output');
    expect(workflowTargetSources({ origin: payload })).not.toContain('model_output');
  });

  it('treats prototype names and numeric keys as ordinary own paths', () => {
    const origin = replaceWorkflowOrigin({ origin: workflowValueOrigin({ source: 'definition' }), path: ['__proto__', 'constructor', 0], replacement: workflowValueOrigin({ source: 'file_input' }) });
    const projected = workflowFieldOrigin({ origin: workflowFieldOrigin({ origin: workflowFieldOrigin({ origin, key: '__proto__' }), key: 'constructor' }), key: 0 });
    expect(workflowOriginSources({ origin: projected })).toEqual(['file_input']);
    expect(workflowOriginSources({ origin: workflowFieldOrigin({ origin, key: 'constructor' }) })).toEqual(['definition']);
    expect(Object.getPrototypeOf(origin.properties)).toBe(Object.prototype);
  });

  it('bounds repeated sequence summaries by the finite set of source kinds', () => {
    let origin = workflowValueOrigin({ source: 'definition' });
    for (let index = 0; index < 10000; index++) {
      origin = mergeWorkflowOrigins({ origins: [origin, workflowValueOrigin({ source: 'model_output' }), workflowValueOrigin({ source: 'file_input' })] });
    }
    expect(origin.properties).toEqual({});
    expect(origin.sources).toEqual(['definition', 'model_output', 'file_input']);
  });

  it('does not treat empty evidence as proof of a fixed target', () => {
    expect(isDefinitionWorkflowTarget({ sources: workflowTargetSources({ origin: { sources: [], properties: {} } }) })).toBe(false);
  });

  it('visits a shared deep origin graph once without recursive stack growth', () => {
    let origin: WorkflowValueProvenance = workflowValueOrigin({ source: 'file_input' });
    for (let index = 0; index < 20000; index++) {
      origin = { sources: ['definition'], properties: { first: origin, second: origin } };
    }
    expect(workflowOriginSources({ origin })).toEqual(['definition', 'file_input']);
  });
});
