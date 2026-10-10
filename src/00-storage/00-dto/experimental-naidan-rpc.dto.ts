import * as dtozod from '@/utils/dtozod';
import { CryptoKeySchemaDto } from './compatibility/crypto-key';

export const ExperimentalNaidanRpcPublicKeySchemaDto = dtozod.string();
export const ExperimentalNaidanRpcTransportSchemaDto = dtozod.object({
  type: dtozod.literal('naidan_piping_duplex'),
  serverUrl: dtozod.string(),
  headers: dtozod.array(dtozod.object({ name: dtozod.string(), value: dtozod.string() })),
});
export const ExperimentalNaidanRpcRegistrationSchemaDto = dtozod.object({
  id: dtozod.string(),
  peerPublicKey: ExperimentalNaidanRpcPublicKeySchemaDto,
  localPublicKey: ExperimentalNaidanRpcPublicKeySchemaDto,
  label: dtozod.string(),
  transport: ExperimentalNaidanRpcTransportSchemaDto,
  inboundAllowedMethods: dtozod.array(dtozod.string()),
  connectOnStartup: dtozod.enum(['disabled', 'enabled']),
  revision: dtozod.number(),
});
export type ExperimentalNaidanRpcRegistrationDto = dtozod.infer<typeof ExperimentalNaidanRpcRegistrationSchemaDto>;
export const ExperimentalNaidanRpcRegistrySchemaDto = dtozod.object({
  version: dtozod.literal(1),
  id: dtozod.string(),
  registrations: dtozod.array(ExperimentalNaidanRpcRegistrationSchemaDto),
});
export type ExperimentalNaidanRpcRegistryDto = dtozod.infer<typeof ExperimentalNaidanRpcRegistrySchemaDto>;
export const ExperimentalNaidanRpcIdentitySchemaDto = dtozod.object({
  privateKey: CryptoKeySchemaDto,
  publicKey: ExperimentalNaidanRpcPublicKeySchemaDto,
});
export const TEST_ONLY = {
};
