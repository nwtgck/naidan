// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createQ8KernelDiagnosticAdapter, type Q8DiagnosticAccess } from './q8-kernel-diagnostic';
import { diagnosticSchemaFixture } from './q8-kernel-diagnostic-schema.test-support';

function fixture() {
  const enter = vi.fn(async () => {
    throw new Error('Native ownership must not start during metadata admission');
  });
  const access: Q8DiagnosticAccess = { assertIdle: vi.fn(), withAccess: enter };
  return { schema: diagnosticSchemaFixture(), access, enter };
}

describe('binary-selected Q8 diagnostic metadata', () => {
  it('uses the selected target descriptor without downloading, hashing or opening native ownership', async () => {
    const test = fixture();
    using fetcher = vi.spyOn(globalThis, 'fetch');
    using digest = vi.spyOn(crypto.subtle, 'digest');
    expect(await createQ8KernelDiagnosticAdapter(test)).toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
    expect(test.enter).not.toHaveBeenCalled();
  });

  it('permits global IDs, reordered metadata and unrelated additions while retaining the wire contract', async () => {
    const test = fixture();
    test.schema.functions.push({ ...test.schema.functions[0]!, name: 'future_function', export: '_future_function' });
    test.schema.records.push({ ...test.schema.records[0]!, id: 42, name: 'future_record', fields: [] });
    test.schema.constants.push('FUTURE_SIGNED_CONSTANT');
    test.schema.constantValues.FUTURE_SIGNED_CONSTANT = '-1';
    test.schema.records.reverse();
    for (const record of test.schema.records) {
      record.id += 173;
      record.fields.reverse();
      for (const field of record.fields) {
        field.id += 47;
      }
    }
    const schema = { ...test.schema, futureDescription: { url: 'https://untrusted.invalid/unused.json' } };
    using fetcher = vi.spyOn(globalThis, 'fetch');
    expect(await createQ8KernelDiagnosticAdapter({ schema, access: test.access })).toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    {},
    { ...diagnosticSchemaFixture(), baseAbiVersion: 1 },
    { ...diagnosticSchemaFixture(), pointerRepresentation: 'number' },
    { ...diagnosticSchemaFixture(), suspension: 'asyncify' },
  ])('rejects absent or incompatible target metadata before native work: %j', async schema => {
    const test = fixture();
    using fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(createQ8KernelDiagnosticAdapter({ schema, access: test.access })).rejects.toThrow();
    expect(test.enter).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects oversized layout metadata before any allocation can happen', async () => {
    const test = fixture();
    test.schema.records[0]!.size = 8192;
    await expect(createQ8KernelDiagnosticAdapter(test)).rejects.toThrow('record layout');
    expect(test.enter).not.toHaveBeenCalled();
  });

  it.each(['missing-constant', 'shifted-field', 'unexpected-field'] as const)('rejects a malformed %s descriptor before native work', async failure => {
    const test = fixture();
    switch (failure) {
    case 'missing-constant': delete test.schema.constantValues[test.schema.constants[0]!];
      break;
    case 'shifted-field': test.schema.records[0]!.fields[1]!.offset = 0;
      break;
    case 'unexpected-field': test.schema.records[0]!.fields[0]!.name = '日本語';
      break;
    default: {
      const exhaustive: never = failure;
      throw new Error(String(exhaustive));
    }
    }
    await expect(createQ8KernelDiagnosticAdapter(test)).rejects.toThrow();
    expect(test.enter).not.toHaveBeenCalled();
  });

  it('checks the owner gate before examining metadata', async () => {
    const test = fixture();
    const busy = new Error('Serialize access while a native call is pending');
    vi.mocked(test.access.assertIdle).mockImplementation(() => {
      throw busy;
    });
    using fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(createQ8KernelDiagnosticAdapter({ schema: undefined, access: test.access })).rejects.toBe(busy);
    expect(fetcher).not.toHaveBeenCalled();
    expect(test.enter).not.toHaveBeenCalled();
  });
});
