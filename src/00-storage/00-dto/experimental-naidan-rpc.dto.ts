import { z } from 'zod';

export const ExperimentalNaidanRpcPublicKeySchemaDto = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const ExperimentalNaidanRpcTransportSchemaDto = z.object({
  type: z.literal('naidan_piping_duplex'),
  serverUrl: z.string().max(4096),
  headers: z.array(z.object({ name: z.string().min(1).max(128), value: z.string().max(8192) })).max(32),
});
export const ExperimentalNaidanRpcConnectionSchemaDto = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  peerId: ExperimentalNaidanRpcPublicKeySchemaDto,
  localPublicKey: ExperimentalNaidanRpcPublicKeySchemaDto,
  label: z.string().min(1).max(100),
  transport: ExperimentalNaidanRpcTransportSchemaDto,
  allowedMethods: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)).max(64)
    .refine(names => new Set(names).size === names.length, 'Duplicate RPC method'),
  autoConnect: z.enum(['disabled', 'enabled']),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
});
export type ExperimentalNaidanRpcConnectionDto = z.infer<typeof ExperimentalNaidanRpcConnectionSchemaDto>;
export const ExperimentalNaidanRpcRegistrySchemaDto = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  connections: z.array(ExperimentalNaidanRpcConnectionSchemaDto).max(32)
    .refine(connections => new Set(connections.map(connection => connection.id)).size === connections.length, 'Duplicate RPC connection'),
});
export type ExperimentalNaidanRpcRegistryDto = z.infer<typeof ExperimentalNaidanRpcRegistrySchemaDto>;
export const ExperimentalNaidanRpcIdentitySchemaDto = z.object({
  privateKey: z.custom<CryptoKey>(value => typeof CryptoKey !== 'undefined' && value instanceof CryptoKey
    && value.type === 'private' && !value.extractable && value.algorithm.name === 'X25519'
    && value.usages.length === 1 && value.usages[0] === 'deriveBits'),
  publicKey: ExperimentalNaidanRpcPublicKeySchemaDto,
});
export const TEST_ONLY = {
};
