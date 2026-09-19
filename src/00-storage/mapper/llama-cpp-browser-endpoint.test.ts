import { describe, expect, it } from 'vitest';
import { endpointToDomain, endpointToDto } from '@/00-storage/mapper/mappers';
import { EndpointSchemaDto } from '@/00-storage/00-dto/dto';
import { areEndpointsEqual, areEndpointModelNamespacesEqual, cloneEndpoint, isHttpEndpoint, isConfiguredEndpoint } from '@/01-models/endpoint';

describe('llama.cpp endpoint boundary', () => {
  it('uses an experimental storage envelope but a normal domain discriminator', () => {
    const dto = EndpointSchemaDto.parse({ type: 'experimental_type', experimental: { type: 'llama_cpp_browser' } });
    expect(endpointToDomain({ dto })).toEqual({ type: 'llama_cpp_browser' });
    expect(endpointToDto({ endpoint: { type: 'llama_cpp_browser' } })).toEqual({ type: 'experimental_type', experimental: { type: 'llama_cpp_browser' } });
  });
  it('retains the browser-provided endpoint as a distinct experimental alternative', () => {
    expect(endpointToDomain({ dto: EndpointSchemaDto.parse({ type: 'experimental_type', experimental: { type: 'browser_provided_lm' } }) })).toEqual({ type: 'browser_provided_lm' });
  });
  it('does not accept the domain discriminator as a stable top-level storage variant', () => {
    expect(EndpointSchemaDto.safeParse({ type: 'llama_cpp_browser' }).success).toBe(false);
  });
  it('preserves unsupported behavior for an unknown experimental subtype', () => {
    expect(endpointToDomain({ dto: EndpointSchemaDto.parse({ type: 'experimental_type', experimental: { type: 'future_browser_engine' } }) }).type).toBe('unsupported_experimental_endpoint');
  });
  it('is configured without an HTTP URL and clones as its own endpoint', () => {
    expect(isHttpEndpoint({ type: 'llama_cpp_browser' })).toBe(false);
    expect(isConfiguredEndpoint({ endpoint: { type: 'llama_cpp_browser' } })).toBe(true);
    expect(cloneEndpoint({ endpoint: { type: 'llama_cpp_browser' } })).toEqual({ type: 'llama_cpp_browser' });
  });
  it('keeps model namespaces and equality distinct from Prompt API and tjs', () => {
    expect(areEndpointsEqual({ left: { type: 'llama_cpp_browser' }, right: { type: 'llama_cpp_browser' } })).toBe(true);
    expect(areEndpointsEqual({ left: { type: 'llama_cpp_browser' }, right: { type: 'browser_provided_lm' } })).toBe(false);
    expect(areEndpointsEqual({ left: { type: 'browser_provided_lm' }, right: { type: 'llama_cpp_browser' } })).toBe(false);
    expect(areEndpointModelNamespacesEqual({ left: { type: 'llama_cpp_browser' }, right: { type: 'transformers_js' } })).toBe(false);
    expect(areEndpointModelNamespacesEqual({ left: { type: 'browser_provided_lm' }, right: { type: 'llama_cpp_browser' } })).toBe(false);
  });
});
