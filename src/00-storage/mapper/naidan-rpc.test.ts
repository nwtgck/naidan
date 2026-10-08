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

it('rejects unknown own keys at every stored authority boundary', () => {
  const dto = rpcRegistrationToDto({ registration });
  for (const key of ['future', '__proto__', 'constructor', 'prototype', 'peerId', 'allowedMethods', 'autoConnect']) {
    const extra = Object.fromEntries([[key, undefined]]);
    expect(() => rpcRegistrationFromDto({ value: { ...dto, ...extra } })).toThrow();
    expect(() => rpcRegistrationFromDto({ value: { ...dto, transport: { ...dto.transport, ...extra } } })).toThrow();
    expect(() => rpcRegistrationFromDto({ value: { ...dto, transport: { ...dto.transport, headers: [{ ...dto.transport.headers[0], ...extra }] } } })).toThrow();
  }
});

it('writes registration version two and rejects old or mixed records without migration', () => {
  const dto = rpcRegistrationToDto({ registration });
  expect(dto.version).toBe(2);
  expect(() => rpcRegistrationFromDto({ value: { ...dto, version: 1 } })).toThrow();
  const { peerPublicKey, inboundAllowedMethods, connectOnStartup, ...rest } = dto;
  const old = { ...rest, version: 1, peerId: peerPublicKey, allowedMethods: inboundAllowedMethods, autoConnect: connectOnStartup };
  expect(() => rpcRegistrationFromDto({ value: old })).toThrow();
  expect(() => rpcRegistrationFromDto({ value: { ...old, ...dto } })).toThrow();
});

it('RPC endpoints clone only a registration reference, never a live proxy transport', () => {
  const endpoint = reactive({ type: 'naidan_rpc' as const, registrationId: registration.id });
  const cloned = cloneEndpoint({ endpoint }); expect(structuredClone(cloned)).toEqual({ type: 'naidan_rpc', registrationId: registration.id });
  expect(isConfiguredEndpoint({ endpoint })).toBe(true); expect(isConfiguredEndpoint({ endpoint: { type: 'naidan_rpc', registrationId: undefined } })).toBe(false);
  expect(areEndpointsEqual({ left: endpoint, right: { type: 'naidan_rpc', registrationId: toNaidanRpcRegistrationId({ raw: 'another-registration' }) } })).toBe(false);
});

it('does not accept wildcard authority or silently discard duplicate methods', () => {
  const dto = rpcRegistrationToDto({ registration });
  expect(ExperimentalNaidanRpcRegistrationSchemaDto.safeParse({ ...dto, inboundAllowedMethods: ['*'] }).success).toBe(false);
  expect(ExperimentalNaidanRpcRegistrationSchemaDto.safeParse({ ...dto, inboundAllowedMethods: ['generateChat', 'generateChat'] }).success).toBe(false);
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
