import { installSecretEqualityTester } from '@/utils/secret.test-support';
import { Secret } from '@/utils/secret';
import { describe, it, expect } from 'vitest';
import { parseWorkflowDefinition, parseWorkflowJson, formatWorkflowDefinition, applyWorkflowStepJson, parseWorkflowValue, formatWorkflowValue } from './workflow-json';
import { toWorkflowStepId } from '@/01-models/ids';
import type { WorkflowStep, WorkflowValue } from '@/01-models/workflow';

installSecretEqualityTester();

describe('Workflow editable JSON boundary', () => {
  const step: WorkflowStep = { id: toWorkflowStepId({ raw: 'step' }), name: 'value', type: 'value', value: { type: 'literal', value: { type: 'article', title: 'keep', nested: { count: 1 } } } };

  it('rejects storage metadata in editable definitions instead of silently dropping it', () => {
    for (const metadata of [{ createdAt: 12 }, { updatedAt: 13 }, { id: 'document' }]) {
      expect(() => parseWorkflowDefinition({ text: JSON.stringify({ name: '', steps: [], ...metadata }) })).toThrow();
    }
    expect(JSON.parse(formatWorkflowDefinition({ definition: { name: '', steps: [step] } }))).toHaveProperty('steps.0.id', 'step');
  });

  it('rejects duplicate keys including escaped spellings and deeply nested input', () => {
    expect(() => parseWorkflowJson({ text: '{"name":1,"n\\u0061me":2}' })).toThrow('Duplicate');
    expect(() => parseWorkflowJson({ text: '['.repeat(70) + '0' + ']'.repeat(70) })).toThrow('deep');
    expect(() => parseWorkflowJson({ text: '1e999' })).toThrow();
    expect(parseWorkflowJson({ text: '{"a": {"name":1},"b":{"name":2}}' })).toEqual({ a: { name: 1 }, b: { name: 2 } });
  });

  it('enforces UTF-8 bytes before parsing', () => {
    expect(() => parseWorkflowJson({ text: JSON.stringify('語'.repeat(750000)) })).toThrow('2 MiB');
  });

  it('merges ordinary JSON type fields without deleting unrelated literal data', () => {
    const result = applyWorkflowStepJson({ step, text: '{"value":{"value":{"type":"book","nested":{"extra":2}}}}' });
    expect(result).toMatchObject({ value: { value: { type: 'book', title: 'keep', nested: { count: 1, extra: 2 } } } });
    expect(step.value).toMatchObject({ value: { type: 'article' } });
  });

  it('replaces actual expression variants atomically and rejects changed step identity', () => {
    const result = applyWorkflowStepJson({ step, text: '{"value":{"type":"array","items":[]}}' });
    expect(result).toMatchObject({ value: { type: 'array', items: [] } });
    expect(() => applyWorkflowStepJson({ step, text: '{"id":"other"}' })).toThrow();
    expect(() => applyWorkflowStepJson({ step, text: '{"type":"parse_json"}' })).toThrow();
    expect(() => applyWorkflowStepJson({ step, text: '{"unknown":true}' })).toThrow();
  });

  it('replaces arrays rather than concatenating or merging indices', () => {
    const arrayStep: WorkflowStep = { ...step, value: { type: 'literal', value: [1, 2, 3] } };
    expect(applyWorkflowStepJson({ step: arrayStep, text: '{"value":{"value":[4]}}' })).toMatchObject({ value: { value: [4] } });
  });

  it('uses the existing endpoint DTO for browser and HTTP models', () => {
    const browser: WorkflowValue = { type: 'model', modelId: 'model', endpoint: { type: 'llama_cpp_browser' } };
    const json = formatWorkflowValue({ value: browser });
    expect(JSON.parse(json)).toMatchObject({ endpoint: { type: 'llama_cpp_browser' } });
    expect(parseWorkflowValue({ text: json })).toEqual(browser);
    const legacy = JSON.stringify({ type: 'model', modelId: 'model', endpoint: { type: 'experimental_type', experimental: { endpoint: { type: 'llama_cpp_browser' } } } });
    expect(parseWorkflowValue({ text: legacy })).toEqual(browser);
    expect(JSON.parse(formatWorkflowValue({ value: parseWorkflowValue({ text: legacy }) }))).toHaveProperty('endpoint.type', 'llama_cpp_browser');
    const http: WorkflowValue = { type: 'model', modelId: 'same', endpoint: { type: 'openai', url: 'http://localhost:1234', httpHeaders: [['Authorization', Secret.from({ value: 'secret' })]] } };
    expect(parseWorkflowValue({ text: formatWorkflowValue({ value: http }) })).toEqual(http);
  });
});
