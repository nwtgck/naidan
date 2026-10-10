import { expect, it } from 'vitest';
import { reactive } from 'vue';
import { rpcRegistrationFromDto, rpcRegistrationToDto } from './naidan-rpc';
import { toNaidanRpcRegistrationId, toNaidanRpcPeerPublicKey } from '@/01-models/ids';
import type { NaidanRpcRegistration } from '@/01-models/naidan-rpc';
import { cloneEndpoint, areEndpointsEqual, isConfiguredEndpoint } from '@/01-models/endpoint';
import { ExperimentalNaidanRpcRegistrationSchemaDto } from '@/00-storage/00-dto/experimental-naidan-rpc.dto';
const registration: NaidanRpcRegistration = {
  id: toNaidanRpcRegistrationId({ raw: 'registration-1' }),
  peerPublicKey: toNaidanRpcPeerPublicKey({ raw: 'B'.repeat(43) }),
  connectOnStartup: 'disabled',
  localPublicKey: 'A'.repeat(43),
  label: 'Peer',
  revision: 0,
  inboundAllowedMethods: ['generateChat'],
  transport: { type: 'naidan_piping_duplex', serverUrl: 'https://relay.example', headers: [{ name: 'Authorization', value: 'secret' }] },
};

it('projects nested Vue proxies to a cloneable persistence record without losing headers', () => {
  const form = reactive(registration); expect(() => structuredClone(form.transport)).toThrow();
  const dto = rpcRegistrationToDto({ registration: form }); expect(structuredClone(dto)).toEqual(dto);
  const restored = rpcRegistrationFromDto({ value: dto }); expect(restored).toEqual(registration);
});

it('projects declared storage fields without adding RPC-only property retention', () => {
  const dto = rpcRegistrationToDto({ registration });
  const extra = JSON.parse('{"future":true,"__proto__":{"untrusted":true},"constructor":42}');
  expect(rpcRegistrationFromDto({ value: { ...dto, ...extra } })).toEqual(registration);
  expect(Object.prototype).not.toHaveProperty('untrusted');
});

it('has no redundant registration version and requires the new declared fields', () => {
  const dto = rpcRegistrationToDto({ registration }); expect(dto).not.toHaveProperty('version');
  const { peerPublicKey, inboundAllowedMethods, connectOnStartup, ...rest } = dto;
  const old = { ...rest, peerId: peerPublicKey, allowedMethods: inboundAllowedMethods, autoConnect: connectOnStartup };
  expect(() => rpcRegistrationFromDto({ value: old })).toThrow();
});

it('RPC endpoints clone only a registration reference, never a live proxy transport', () => {
  const endpoint = reactive({ type: 'naidan_rpc' as const, registrationId: registration.id });
  const cloned = cloneEndpoint({ endpoint }); expect(structuredClone(cloned)).toEqual({ type: 'naidan_rpc', registrationId: registration.id });
  expect(isConfiguredEndpoint({ endpoint })).toBe(true); expect(isConfiguredEndpoint({ endpoint: { type: 'naidan_rpc', registrationId: undefined } })).toBe(false);
  expect(areEndpointsEqual({ left: endpoint, right: { type: 'naidan_rpc', registrationId: toNaidanRpcRegistrationId({ raw: 'another-registration' }) } })).toBe(false);
});

it('keeps method strings structural and normalizes duplicate names', () => {
  const dto = rpcRegistrationToDto({ registration });
  expect(ExperimentalNaidanRpcRegistrationSchemaDto.parse({ ...dto, inboundAllowedMethods: ['*'] }).inboundAllowedMethods).toEqual(['*']);
  expect(rpcRegistrationFromDto({ value: { ...dto, inboundAllowedMethods: ['generateChat', 'generateChat'] } }).inboundAllowedMethods).toEqual(['generateChat']);
});

it.each([-1, 0.5, Number.MAX_SAFE_INTEGER])('keeps numeric DTO shape separate from safe revision arithmetic (%s)', revision => {
  const dto = { ...rpcRegistrationToDto({ registration }), revision };
  expect(ExperimentalNaidanRpcRegistrationSchemaDto.parse(dto).revision).toBe(revision);
  expect(() => rpcRegistrationFromDto({ value: dto })).toThrow('revision');
  expect(() => rpcRegistrationToDto({ registration: { ...registration, revision } })).toThrow('revision');
});

it('rejects credential-bearing, remote HTTP and path-bearing relay URLs', () => {
  for (const serverUrl of ['https://user:secret@relay.example', 'http://relay.example', 'https://relay.example/path', 'https://relay.example?secret=x']) {
    expect(() => rpcRegistrationToDto({ registration: { ...registration, transport: { ...registration.transport, serverUrl } } })).toThrow();
  }
});

it('keeps DTO parsing free of URL and label normalization, then validates the domain boundary', () => {
  const dto = rpcRegistrationToDto({ registration });
  const value = { ...dto, label: ' Peer ', transport: { ...dto.transport, serverUrl: 'https://RELAY.example:443/' } };
  expect(ExperimentalNaidanRpcRegistrationSchemaDto.parse(value)).toEqual(value);
  expect(rpcRegistrationFromDto({ value })).toEqual(registration);
  const invalid = { ...dto, transport: { ...dto.transport, serverUrl: 'http://relay.example/path' } };
  expect(ExperimentalNaidanRpcRegistrationSchemaDto.parse(invalid)).toEqual(invalid);
  expect(() => rpcRegistrationFromDto({ value: invalid })).toThrow();
});

it('validates outgoing headers outside the DTO on both read and write', () => {
  const dto = rpcRegistrationToDto({ registration });
  const transport = { ...dto.transport, headers: [{ name: 'Host', value: 'other.example' }] };
  const value = { ...dto, transport };
  expect(ExperimentalNaidanRpcRegistrationSchemaDto.parse(value)).toEqual(value);
  expect(() => rpcRegistrationFromDto({ value })).toThrow();
  expect(() => rpcRegistrationToDto({ registration: { ...registration, transport } })).toThrow();
});

it('copies headers and method arrays so mutating the form cannot widen the saved record', () => {
  const form = reactive({ ...registration, inboundAllowedMethods: ['generateChat'], transport: { ...registration.transport, headers: [{ name: 'Authorization', value: 'secret' }] } });
  const dto = rpcRegistrationToDto({ registration: form }); form.inboundAllowedMethods.push('generateImage'); form.transport.headers[0]!.value = 'changed';
  expect(dto.inboundAllowedMethods).toEqual(['generateChat']); expect(dto.transport.headers[0]!.value).toBe('secret');
});
