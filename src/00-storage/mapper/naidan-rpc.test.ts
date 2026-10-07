import { expect, it } from 'vitest';
import { reactive } from 'vue';
import { rpcConnectionFromDto, rpcConnectionToDto } from './naidan-rpc';
import { toNaidanRpcConnectionId, toNaidanRpcPeerId } from '@/01-models/ids';
import type { NaidanRpcConnection } from '@/01-models/naidan-rpc';
import { cloneEndpoint, areEndpointsEqual, isConfiguredEndpoint } from '@/01-models/endpoint';
import { ExperimentalNaidanRpcConnectionSchemaDto } from '@/00-storage/00-dto/experimental-naidan-rpc.dto';
const connection: NaidanRpcConnection = {
  id: toNaidanRpcConnectionId({ raw: 'connection-1' }),
  peerId: toNaidanRpcPeerId({ raw: 'B'.repeat(43) }),
  autoConnect: 'disabled',
  localPublicKey: 'A'.repeat(43),
  label: 'Peer',
  revision: 0,
  allowedMethods: ['generateChat'],
  transport: { type: 'naidan_piping_duplex', serverUrl: 'https://relay.example', headers: [{ name: 'Authorization', value: 'secret' }] },
};
it('projects nested Vue proxies to a cloneable persistence record without losing headers', () => {
  const form = reactive(connection); expect(() => structuredClone(form.transport)).toThrow();
  const dto = rpcConnectionToDto({ connection: form }); expect(structuredClone(dto)).toEqual(dto);
  const restored = rpcConnectionFromDto({ value: dto }); expect(restored).toEqual(connection);
});
it('reads additional connection, transport and header fields while preserving known settings', () => {
  const dto = rpcConnectionToDto({ connection });
  const restored = rpcConnectionFromDto({
    value: {
    ...dto,
    future: true,
    transport: { ...dto.transport, future: true, headers: dto.transport.headers.map(header => ({ ...header, future: true })) },
  },
  });
  expect(restored).toEqual(connection);
});
it('RPC endpoints clone only a connection reference, never a live proxy transport', () => {
  const endpoint = reactive({ type: 'naidan_rpc' as const, connectionId: connection.id });
  const cloned = cloneEndpoint({ endpoint }); expect(structuredClone(cloned)).toEqual({ type: 'naidan_rpc', connectionId: connection.id });
  expect(isConfiguredEndpoint({ endpoint })).toBe(true); expect(isConfiguredEndpoint({ endpoint: { type: 'naidan_rpc', connectionId: undefined } })).toBe(false);
  expect(areEndpointsEqual({ left: endpoint, right: { type: 'naidan_rpc', connectionId: toNaidanRpcConnectionId({ raw: 'another-connection' }) } })).toBe(false);
});
it('does not accept wildcard authority or silently discard duplicate methods', () => {
  const dto = rpcConnectionToDto({ connection });
  expect(ExperimentalNaidanRpcConnectionSchemaDto.safeParse({ ...dto, allowedMethods: ['*'] }).success).toBe(false);
  expect(ExperimentalNaidanRpcConnectionSchemaDto.safeParse({ ...dto, allowedMethods: ['generateChat', 'generateChat'] }).success).toBe(false);
});
it('rejects credential-bearing, remote HTTP and path-bearing relay URLs', () => {
  for (const serverUrl of ['https://user:secret@relay.example', 'http://relay.example', 'https://relay.example/path', 'https://relay.example?secret=x']) {
    expect(() => rpcConnectionToDto({ connection: { ...connection, transport: { ...connection.transport, serverUrl } } })).toThrow();
  }
});
it('keeps DTO parsing free of URL and label normalization, then validates the domain boundary', () => {
  const dto = rpcConnectionToDto({ connection });
  const value = { ...dto, label: ' Peer ', transport: { ...dto.transport, serverUrl: 'https://RELAY.example:443/' } };
  expect(ExperimentalNaidanRpcConnectionSchemaDto.parse(value)).toEqual(value);
  expect(rpcConnectionFromDto({ value })).toEqual(connection);
  const invalid = { ...dto, transport: { ...dto.transport, serverUrl: 'http://relay.example/path' } };
  expect(ExperimentalNaidanRpcConnectionSchemaDto.parse(invalid)).toEqual(invalid);
  expect(() => rpcConnectionFromDto({ value: invalid })).toThrow();
});
it('validates outgoing headers outside the DTO on both read and write', () => {
  const dto = rpcConnectionToDto({ connection });
  const transport = { ...dto.transport, headers: [{ name: 'Host', value: 'other.example' }] };
  const value = { ...dto, transport };
  expect(ExperimentalNaidanRpcConnectionSchemaDto.parse(value)).toEqual(value);
  expect(() => rpcConnectionFromDto({ value })).toThrow();
  expect(() => rpcConnectionToDto({ connection: { ...connection, transport } })).toThrow();
});
it('copies headers and method arrays so mutating the form cannot widen the saved record', () => {
  const form = reactive({ ...connection, allowedMethods: ['generateChat'], transport: { ...connection.transport, headers: [{ name: 'Authorization', value: 'secret' }] } });
  const dto = rpcConnectionToDto({ connection: form }); form.allowedMethods.push('generateImage'); form.transport.headers[0]!.value = 'changed';
  expect(dto.allowedMethods).toEqual(['generateChat']); expect(dto.transport.headers[0]!.value).toBe('secret');
});
