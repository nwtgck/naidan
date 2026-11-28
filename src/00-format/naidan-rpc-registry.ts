import { idToRaw, toNaidanRpcRegistryId, type NaidanRpcRegistryId } from '@/01-models/ids';
import type { NaidanRpcRegistration } from '@/01-models/naidan-rpc';
import { ExperimentalNaidanRpcRegistryDtoSchema, type ExperimentalNaidanRpcRegistryDto } from './00-dto/experimental-naidan-rpc.dto';
import { rpcRegistrationFromDto, rpcRegistrationToDto } from './mapper/naidan-rpc';

function validateRegistry({ id, registrations }: { id: string; registrations: readonly { id: string }[] }): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
    throw new Error('Invalid RPC registry identity');
  }
  if (registrations.length > 32) {
    throw new Error('RPC registry capacity exceeded');
  }
  if (new Set(registrations.map(registration => registration.id)).size !== registrations.length) {
    throw new Error('Duplicate RPC registration');
  }
}

function fromDto({ dto }: { dto: ExperimentalNaidanRpcRegistryDto }): { id: NaidanRpcRegistryId, registrations: NaidanRpcRegistration[] } {
  const { version: _version, id, registrations, ...rest } = ExperimentalNaidanRpcRegistryDtoSchema.parse(dto);
  rest satisfies Record<PropertyKey, never>;
  validateRegistry({ id, registrations });
  return { id: toNaidanRpcRegistryId({ raw: id }), registrations: registrations.map(value => rpcRegistrationFromDto({ value })) };
}

function toDto({ id, registrations }: { id: NaidanRpcRegistryId, registrations: readonly NaidanRpcRegistration[] }): ExperimentalNaidanRpcRegistryDto {
  const registry = ExperimentalNaidanRpcRegistryDtoSchema.parse({ version: 1, id: idToRaw({ id }), registrations: registrations.map(registration => rpcRegistrationToDto({ registration })) });
  validateRegistry({ id: registry.id, registrations: registry.registrations });
  return registry;
}

export const naidanRpcRegistryFormat = {
  parseForTransfer({ value }: { value: unknown }): ExperimentalNaidanRpcRegistryDto {
    return ExperimentalNaidanRpcRegistryDtoSchema.parse(value);
  },
  async read({ readForTransfer }: { readForTransfer(): Promise<ExperimentalNaidanRpcRegistryDto | undefined> }): Promise<{ id: NaidanRpcRegistryId, registrations: NaidanRpcRegistration[] } | undefined> {
    const dto = await readForTransfer();
    return dto === undefined ? undefined : fromDto({ dto });
  },
  async write({ registry, writeForTransfer }: {
    registry: { id: NaidanRpcRegistryId, registrations: readonly NaidanRpcRegistration[] },
    writeForTransfer({ registry }: { registry: ExperimentalNaidanRpcRegistryDto }): Promise<void>,
  }): Promise<void> {
    await writeForTransfer({ registry: toDto(registry) });
  },
};

export const TEST_ONLY = {
};
