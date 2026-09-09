// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';
import { readModelFixture, TEST_ONLY } from './model-runtime-fixture';

const temporaryDirectories: string[] = [];

// Share only file ownership mechanics. Each case supplies its own corruption
// and expected contract; the reader must never reinterpret bad evidence as absence.
function resourceDirectory({ asset, bytes }: { asset: string; bytes: Uint8Array }): URL {
  const path = mkdtempSync(join(tmpdir(), 'naidan-runtime-fixture-test-'));
  temporaryDirectories.push(path);
  writeFileSync(join(path, asset), bytes);
  return pathToFileURL(`${path}/`);
}

function sha256({ bytes }: { bytes: Uint8Array }): string {
  return createHash('sha256').update(bytes).digest('hex');
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

it('reads identity assets as fresh browser byte arrays without changing the original bytes', () => {
  const bytes = new TextEncoder().encode('{"model_type":"fixture"}');
  const directory = resourceDirectory({ asset: 'config.json', bytes });
  const resource = {
    path: 'config.json', status: 'recorded' as const,
    asset: 'config.json', encoding: 'identity' as const,
    byteLength: bytes.byteLength, sha256: sha256({ bytes }),
  };
  const first = TEST_ONLY.readRecordedResource({ directory, resource });
  expect(first).toEqual(bytes);
  expect(first.constructor).toBe(Uint8Array);
  first.fill(0);
  expect(TEST_ONLY.readRecordedResource({ directory, resource })).toEqual(bytes);
});

it('verifies the decoded bytes of a losslessly compressed asset', () => {
  const bytes = new TextEncoder().encode('{"vocab":{"fixture":0}}');
  const directory = resourceDirectory({ asset: 'tokenizer.json.gz', bytes: gzipSync(bytes) });
  const actual = TEST_ONLY.readRecordedResource({
    directory,
    resource: {
      path: 'tokenizer.json', status: 'recorded',
      asset: 'tokenizer.json.gz', encoding: 'gzip',
      byteLength: bytes.byteLength, sha256: sha256({ bytes }),
    },
  });
  expect(actual.constructor).toBe(Uint8Array);
  expect(actual).toEqual(bytes);
});

it('rejects same-length corrupted data instead of replaying it', () => {
  const original = new TextEncoder().encode('{"vocab":{"original":0}}');
  const corrupted = new TextEncoder().encode('{"vocab":{"modified":0}}');
  expect(corrupted.byteLength).toBe(original.byteLength);
  const directory = resourceDirectory({ asset: 'tokenizer.json', bytes: corrupted });
  expect(() => TEST_ONLY.readRecordedResource({
    directory,
    resource: {
      path: 'tokenizer.json', status: 'recorded',
      asset: 'tokenizer.json', encoding: 'identity',
      byteLength: original.byteLength, sha256: sha256({ bytes: original }),
    },
  })).toThrow('Invalid checked-in original bytes: tokenizer.json');
});

it('rejects a size disagreement even when the checksum describes the stored bytes', () => {
  const bytes = new TextEncoder().encode('{}');
  const directory = resourceDirectory({ asset: 'config.json', bytes });
  expect(() => TEST_ONLY.readRecordedResource({
    directory,
    resource: {
      path: 'config.json', status: 'recorded',
      asset: 'config.json', encoding: 'identity',
      byteLength: bytes.byteLength + 1, sha256: sha256({ bytes }),
    },
  })).toThrow('Invalid checked-in original bytes: config.json');
});

it('rejects a truncated gzip asset rather than producing an incomplete vocabulary', () => {
  const bytes = new TextEncoder().encode('{"vocab":{"fixture":0}}');
  const compressed = gzipSync(bytes);
  const directory = resourceDirectory({ asset: 'tokenizer.json.gz', bytes: compressed.subarray(0, compressed.byteLength - 4) });
  expect(() => TEST_ONLY.readRecordedResource({
    directory,
    resource: {
      path: 'tokenizer.json', status: 'recorded',
      asset: 'tokenizer.json.gz', encoding: 'gzip',
      byteLength: bytes.byteLength, sha256: sha256({ bytes }),
    },
  })).toThrow();
});

it('bounds gzip expansion by the declared decoded length', () => {
  const bytes = new TextEncoder().encode('x'.repeat(4096));
  const directory = resourceDirectory({ asset: 'tokenizer.json.gz', bytes: gzipSync(bytes) });
  expect(() => TEST_ONLY.readRecordedResource({
    directory,
    resource: {
      path: 'tokenizer.json', status: 'recorded',
      asset: 'tokenizer.json.gz', encoding: 'gzip',
      byteLength: 32, sha256: sha256({ bytes }),
    },
  })).toThrow(expect.objectContaining({ code: 'ERR_BUFFER_TOO_LARGE' }));
});

it('rejects an unregistered model instead of finding an external evidence source', () => {
  expect(() => readModelFixture({ modelId: 'fixture/unregistered-model' }))
    .toThrow('No checked-in model fixture: fixture/unregistered-model');
});
