import * as dtozod from '@/utils/dtozod';
import { CryptoKeyDtoSchema } from './compatibility/crypto-key';

export const ExperimentalNaidanRpcPublicKeyDtoSchema = dtozod.string();
export const ExperimentalNaidanRpcTransportDtoSchema = dtozod.object({
  type: dtozod.literal('naidan_piping_duplex'),
  serverUrl: dtozod.string(),
  headers: dtozod.array(dtozod.object({ name: dtozod.string(), value: dtozod.string() })),
});
export const ExperimentalNaidanRpcRegistrationDtoSchema = dtozod.object({
  id: dtozod.string(),
  peerPublicKey: ExperimentalNaidanRpcPublicKeyDtoSchema,
  localPublicKey: ExperimentalNaidanRpcPublicKeyDtoSchema,
  label: dtozod.string(),
  transport: ExperimentalNaidanRpcTransportDtoSchema,
  inboundAllowedMethods: dtozod.array(dtozod.string()),
  connectOnStartup: dtozod.enum(['disabled', 'enabled']),
  revision: dtozod.number(),
});
export type ExperimentalNaidanRpcRegistrationDto = dtozod.infer<typeof ExperimentalNaidanRpcRegistrationDtoSchema>;
export const ExperimentalNaidanRpcRegistryDtoSchema = dtozod.object({
  version: dtozod.literal(1),
  id: dtozod.string(),
  registrations: dtozod.array(ExperimentalNaidanRpcRegistrationDtoSchema),
});
export type ExperimentalNaidanRpcRegistryDto = dtozod.infer<typeof ExperimentalNaidanRpcRegistryDtoSchema>;
export const ExperimentalNaidanRpcIdentityDtoSchema = dtozod.object({
  privateKey: CryptoKeyDtoSchema,
  publicKey: ExperimentalNaidanRpcPublicKeyDtoSchema,
});
export const TEST_ONLY = {
};
