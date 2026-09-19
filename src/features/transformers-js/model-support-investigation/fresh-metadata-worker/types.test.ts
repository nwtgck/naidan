// @vitest-environment node
import { expect, it } from 'vitest';
import { freshMetadataResultSchema, freshMetadataSummarySchema, type FreshMetadataResult } from './types';

function result(): FreshMetadataResult {
  return {
    summary: {
      schemaVersion: 1, modelId: 'fixture/model', revision: 'a'.repeat(40), source: 'fresh-network-memory',
      status: 'prepared', maximumBytes: 1024, receivedBytes: 2,
      requests: [{ consumer: 'runtime-preparation', path: 'config.json', request: 'full', status: 'complete', receivedBytes: 2 }],
      preparation: { processor: 'tokenizer', resourcePlansByCandidate: {} },
    },
    replayMetadata: {
      schemaVersion: 1, modelId: 'fixture/model', revision: 'a'.repeat(40), status: 'complete',
      budgetBytes: 1024, receivedBytes: 2, retainedBytes: 2,
      files: [{ path: 'config.json', source: 'remote-exact', status: 'collected', byteLength: 2, sha256: '0'.repeat(64) }],
    },
    files: [{ path: 'config.json', blob: new Blob(['{}']) }],
  };
}

it('accepts structurally consistent fresh evidence; content hashes remain the export boundary responsibility', () => {
  expect(freshMetadataResultSchema.safeParse(result()).success).toBe(true);
});

it('rejects replay metadata from a different exact revision', () => {
  const value = result();
  value.replayMetadata!.revision = 'b'.repeat(40);
  expect(freshMetadataResultSchema.safeParse(value).success).toBe(false);
});

it('allows running observations but rejects them as a final Worker result', () => {
  const value = result();
  value.summary.status = 'running';
  value.summary.preparation = undefined;
  expect(freshMetadataSummarySchema.safeParse(value.summary).success).toBe(true);
  expect(freshMetadataResultSchema.safeParse(value).success).toBe(false);
});

it('rejects replay metadata from another model', () => {
  const value = result();
  value.replayMetadata!.modelId = 'fixture/another-model';
  expect(freshMetadataResultSchema.safeParse(value).success).toBe(false);
});

it('rejects a sidecar whose size differs from the collected file observation', () => {
  const value = result();
  value.files[0]!.blob = new Blob(['{"extra":true}']);
  expect(freshMetadataResultSchema.safeParse(value).success).toBe(false);
});

it('rejects duplicate sidecars instead of letting archive insertion overwrite one', () => {
  const value = result();
  value.files.push(value.files[0]!);
  expect(freshMetadataResultSchema.safeParse(value).success).toBe(false);
});

it('rejects extra sidecars not present in the collected-file manifest', () => {
  const initial = result();
  const value = { ...initial, files: [...initial.files, { path: 'private-notes.json', blob: new Blob(['{}']) }] };
  expect(freshMetadataResultSchema.safeParse(value).success).toBe(false);
});

it('rejects an independently enlarged replay budget', () => {
  const value = result();
  value.replayMetadata!.budgetBytes = 2048;
  expect(freshMetadataResultSchema.safeParse(value).success).toBe(false);
});

it('rejects OPFS provenance in a fresh network result', () => {
  const value = result();
  value.replayMetadata!.files[0]!.source = 'local-exact';
  expect(freshMetadataResultSchema.safeParse(value).success).toBe(false);
});
