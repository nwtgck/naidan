import { describe, expect, it } from 'vitest';
import { toModelGraphRegistrationId } from '@/01-models/ids';
import type { ModelGraphRegistration } from '@/01-models/model-graph-registry';
import { modelGraphRequestRegistrations, modelGraphRequestRegistrationsSchema, type ModelGraphRequestRegistration } from './request-registry';

function entry({ index = 0 }: { index?: number } = {}): ModelGraphRequestRegistration {
  return {
    id: `registration-${index}`,
    label: 'Fixture',
    source: '{}',
    sourceSha256: 'a'.repeat(64),
    rule: { mode: 'replaceNative', architecture: `arch-${index}`, approvedSha256: 'a'.repeat(64) },
  };
}

describe('lightweight request-time model graph authority', () => {
  it('snapshots active local rules without parsing source or retaining mutable references', () => {
    const wire = entry();
    const record: ModelGraphRegistration = { ...wire, id: toModelGraphRegistrationId({ raw: wire.id }) };
    const result = modelGraphRequestRegistrations({ registrations: [record, { ...record, rule: { mode: 'disabled' } }] });
    expect(result).toEqual([wire]);
    // A full definition is checked after choosing local authority. Dropping
    // invalid overrides here could silently allow native execution instead.
    record.source = '{"changed":true}';
    record.rule = { mode: 'disabled' };
    expect(result).toEqual([wire]);
  });

  it('does not accept portable execution permissions or extra transport fields', () => {
    expect(() => modelGraphRequestRegistrationsSchema.parse([{ ...entry(), enabled: true }])).toThrow();
    expect(() => modelGraphRequestRegistrationsSchema.parse([{ ...entry(), rule: { mode: 'disabled' } }])).toThrow();
    expect(() => modelGraphRequestRegistrationsSchema.parse([{ ...entry(), rule: { ...entry().rule, callback: 'execute' } }])).toThrow();
  });

  it('rejects duplicate record identities and overlapping architecture rules', () => {
    expect(() => modelGraphRequestRegistrationsSchema.parse([entry(), entry()])).toThrow();
    expect(() => modelGraphRequestRegistrationsSchema.parse([entry(), { ...entry({ index: 1 }), rule: entry().rule }])).toThrow();
    expect(() => modelGraphRequestRegistrationsSchema.parse([entry(), { ...entry({ index: 1 }), id: entry().id }])).toThrow();
  });

  it('bounds record count, UTF-8 bytes and aggregate source size', () => {
    expect(() => modelGraphRequestRegistrationsSchema.parse(Array.from({ length: 33 }, (_, index) => entry({ index })))).toThrow();
    expect(() => modelGraphRequestRegistrationsSchema.parse([{ ...entry(), source: 'あ'.repeat(400_000) }])).toThrow();
    const records = Array.from({ length: 5 }, (_, index) => ({ ...entry({ index }), source: 'x'.repeat(1024 * 1024) }));
    expect(() => modelGraphRequestRegistrationsSchema.parse(records)).toThrow();
  });
});
