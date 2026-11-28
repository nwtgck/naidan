import { idToRaw, toModelGraphRegistryId, type ModelGraphRegistryId } from '@/01-models/ids';
import { modelGraphSourceDigest, type ModelGraphRegistration } from '@/01-models/model-graph-registry';
import { ExperimentalModelGraphRegistryDtoSchema, type ExperimentalModelGraphRegistryDto } from './00-dto/experimental-model-graph.dto';
import { modelGraphRegistrationFromDto, modelGraphRegistrationToDto } from './mapper/model-graph';

function validateModelGraphRegistrations({ registrations }: { registrations: readonly ModelGraphRegistration[] }): void {
  if (registrations.length > 32) {
    throw new Error('At most 32 model graph definitions can be stored');
  }
  const ids = new Set<string>();
  let bytes = 0;
  for (const { id, label, source, sourceSha256, rule } of registrations) {
    const rawId = idToRaw({ id });
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(rawId) || ids.has(rawId)) {
      throw new Error('Invalid or duplicate model graph registration');
    }
    ids.add(rawId);
    if (!label.trim() || label.length > 120) {
      throw new Error('Invalid model graph label');
    }
    const length = new TextEncoder().encode(source).byteLength;
    bytes += length;
    if (!length || length > 1024 * 1024 || bytes > 4 * 1024 * 1024) {
      throw new Error('Model graph registry size limit exceeded');
    }
    if (!/^[a-f0-9]{64}$/.test(sourceSha256) || sourceSha256 !== modelGraphSourceDigest({ source })) {
      throw new Error('Model graph source digest mismatch');
    }
    switch (rule.mode) {
    case 'disabled': break;
    case 'when_architecture_unknown': case 'replace_native':
      if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(rule.architecture) || rule.approvedSha256 !== sourceSha256) {
        throw new Error('Model graph approval does not match the source');
      }
      break;
    default: {
      const exhaustive: never = rule;
      throw new Error(String(exhaustive));
    }
    }
  }
}

function fromDto({ dto }: { dto: ExperimentalModelGraphRegistryDto }): { id: ModelGraphRegistryId, revision: number, registrations: ModelGraphRegistration[] } {
  const { version: _version, id, revision, registrations: stored, ...rest } = ExperimentalModelGraphRegistryDtoSchema.parse(dto);
  rest satisfies Record<PropertyKey, never>;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id) || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('Invalid model graph registry revision');
  }
  const registrations = stored.map(value => modelGraphRegistrationFromDto({ value }));
  // Retain unreadable experimental declarations so they remain editable.
  validateModelGraphRegistrations({ registrations });
  return { id: toModelGraphRegistryId({ raw: id }), revision, registrations };
}

function toDto({ id, revision, registrations }: { id: ModelGraphRegistryId, revision: number, registrations: readonly ModelGraphRegistration[] }): ExperimentalModelGraphRegistryDto {
  validateModelGraphRegistrations({ registrations });
  if (!Number.isSafeInteger(revision)) {
    throw new Error('Model graph revision exhausted');
  }
  return ExperimentalModelGraphRegistryDtoSchema.parse({ version: 1, id: idToRaw({ id }), revision, registrations: registrations.map(registration => modelGraphRegistrationToDto({ registration })) });
}

export const modelGraphRegistryFormat = {
  parseForTransfer({ value }: { value: unknown }): ExperimentalModelGraphRegistryDto {
    return ExperimentalModelGraphRegistryDtoSchema.parse(value);
  },
  async read({ readForTransfer }: { readForTransfer(): Promise<ExperimentalModelGraphRegistryDto | undefined> }): Promise<{ id: ModelGraphRegistryId, revision: number, registrations: ModelGraphRegistration[] } | undefined> {
    const dto = await readForTransfer();
    return dto === undefined ? undefined : fromDto({ dto });
  },
  async write({ registry, writeForTransfer }: {
    registry: { id: ModelGraphRegistryId, revision: number, registrations: readonly ModelGraphRegistration[] },
    writeForTransfer({ registry }: { registry: ExperimentalModelGraphRegistryDto }): Promise<void>,
  }): Promise<void> {
    await writeForTransfer({ registry: toDto(registry) });
  },
};

export const TEST_ONLY = {
};
