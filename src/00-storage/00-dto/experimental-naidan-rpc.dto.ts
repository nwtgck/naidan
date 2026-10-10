import { z } from 'zod';

export const ExperimentalNaidanRpcPublicKeySchemaDto = z.string();
export const ExperimentalNaidanRpcTransportSchemaDto = z.object({
  type: z.literal('naidan_piping_duplex'),
  serverUrl: z.string(),
  headers: z.array(z.object({ name: z.string(), value: z.string() })),
});
export const ExperimentalNaidanRpcRegistrationSchemaDto = z.object({
  id: z.string(),
  peerPublicKey: ExperimentalNaidanRpcPublicKeySchemaDto,
  localPublicKey: ExperimentalNaidanRpcPublicKeySchemaDto,
  label: z.string(),
  transport: ExperimentalNaidanRpcTransportSchemaDto,
  inboundAllowedMethods: z.array(z.string()),
  connectOnStartup: z.enum(['disabled', 'enabled']),
  revision: z.number(),
});
export type ExperimentalNaidanRpcRegistrationDto = z.infer<typeof ExperimentalNaidanRpcRegistrationSchemaDto>;
export const ExperimentalNaidanRpcRegistrySchemaDto = z.object({
  version: z.literal(1),
  id: z.string(),
  registrations: z.array(ExperimentalNaidanRpcRegistrationSchemaDto),
});
export type ExperimentalNaidanRpcRegistryDto = z.infer<typeof ExperimentalNaidanRpcRegistrySchemaDto>;
export const ExperimentalNaidanRpcIdentitySchemaDto = z.object({
  privateKey: z.custom<CryptoKey>(value => typeof CryptoKey !== 'undefined' && value instanceof CryptoKey),
  publicKey: ExperimentalNaidanRpcPublicKeySchemaDto,
});
export const TEST_ONLY = {
};
