import { z } from 'zod';
import { exactRpcObject } from './experimental.dto';

export const ExperimentalNaidanRpcPublicKeySchemaDto = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const ExperimentalNaidanRpcTransportSchemaDto = exactRpcObject({
  schema: z.strictObject({
    type: z.literal('naidan_piping_duplex'),
    serverUrl: z.string().max(4096),
    headers: z.array(exactRpcObject({ schema: z.strictObject({ name: z.string().min(1).max(128), value: z.string().max(8192) }) })).max(32),
  }),
});
export const ExperimentalNaidanRpcRegistrationSchemaDto = exactRpcObject({
  schema: z.strictObject({
    version: z.literal(2),
    id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    peerPublicKey: ExperimentalNaidanRpcPublicKeySchemaDto,
    localPublicKey: ExperimentalNaidanRpcPublicKeySchemaDto,
    label: z.string().min(1).max(100),
    transport: ExperimentalNaidanRpcTransportSchemaDto,
    inboundAllowedMethods: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)).max(64)
      .refine(names => new Set(names).size === names.length, 'Duplicate RPC method'),
    connectOnStartup: z.enum(['disabled', 'enabled']),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  }),
});
export type ExperimentalNaidanRpcRegistrationDto = z.infer<typeof ExperimentalNaidanRpcRegistrationSchemaDto>;
export const ExperimentalNaidanRpcRegistrySchemaDto = exactRpcObject({
  schema: z.strictObject({
    version: z.literal(2),
    id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    registrations: z.array(ExperimentalNaidanRpcRegistrationSchemaDto).max(32)
      .refine(registrations => new Set(registrations.map(registration => registration.id)).size === registrations.length, 'Duplicate RPC registration'),
  }),
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
