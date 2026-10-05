import { z } from 'zod';
import { restrictedFetchHeadersSchema } from '@/utils/restricted-fetch-headers';

export const rpcPublicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const rpcTransportSchema = z.strictObject({
  type: z.literal('naidan_piping_duplex'),
  serverUrl: z.string().max(4096).transform((value, context) => {
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error();
      return url.origin;
    } catch {
      context.addIssue({ code: 'custom', message: 'Use an HTTPS server origin or a loopback HTTP origin' });
      return z.NEVER;
    }
  }),
  headers: restrictedFetchHeadersSchema,
});
export const rpcConnectionSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  peerId: rpcPublicKeySchema,
  localPublicKey: rpcPublicKeySchema,
  label: z.string().trim().min(1).max(100),
  transport: rpcTransportSchema,
  allowedMethods: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)).max(64)
    .refine(names => new Set(names).size === names.length, 'Duplicate RPC method'),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
});
export type RpcConnectionDto = z.infer<typeof rpcConnectionSchema>;
export const rpcIdentitySchema = z.strictObject({
  privateKey: z.custom<CryptoKey>(value => typeof CryptoKey !== 'undefined' && value instanceof CryptoKey
    && value.type === 'private' && !value.extractable && value.algorithm.name === 'X25519'
    && value.usages.length === 1 && value.usages[0] === 'deriveBits'),
  publicKey: rpcPublicKeySchema,
});
export const TEST_ONLY = {
};
