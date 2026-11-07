import { describe, expect, it } from 'vitest';
import { endpointToDomain, endpointToDto, settingsToDomain, settingsToDto } from '@/00-storage/mapper/mappers';
import { EndpointSchemaDto, SettingsSchemaDto } from '@/00-storage/00-dto/dto';
import { ExperimentalImageGenerationTranslationOverrideSchemaDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import { imageGenerationTranslationToDomain, imageGenerationTranslationToDto } from './image-generation';
import { DEFAULT_SETTINGS } from '@/01-models/types';
import { areEndpointsEqual, areEndpointModelNamespacesEqual, cloneEndpoint, isHttpEndpoint, isConfiguredEndpoint } from '@/01-models/endpoint';

describe('llama.cpp endpoint boundary', () => {
  it('persists llama_cpp_browser as a stable top-level discriminator', () => {
    const dto = endpointToDto({ endpoint: { type: 'llama_cpp_browser' } });
    expect(JSON.parse(JSON.stringify(dto))).toStrictEqual({ type: 'llama_cpp_browser' });
    expect(endpointToDomain({ dto: EndpointSchemaDto.parse(dto) })).toStrictEqual({ type: 'llama_cpp_browser' });
  });

  it('reads the legacy experimental llama_cpp_browser envelope and writes the stable discriminator', () => {
    const legacy = EndpointSchemaDto.parse({ type: 'experimental_type', experimental: { endpoint: { type: 'llama_cpp_browser' } } });
    const endpoint = endpointToDomain({ dto: legacy });
    expect(endpoint).toStrictEqual({ type: 'llama_cpp_browser' });
    expect(JSON.parse(JSON.stringify(endpointToDto({ endpoint })))).toStrictEqual({ type: 'llama_cpp_browser' });
  });

  it('uses the stable discriminator in settings without changing experimental engine preferences', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      storageType: 'memory' as const,
      endpoint: { type: 'llama_cpp_browser' as const },
      experimental: { llamaCppBrowser: { contextTokens: 8192 } },
    };
    const dto = settingsToDto({ domain: settings });
    expect(JSON.parse(JSON.stringify(dto)).endpoint).toStrictEqual({ type: 'llama_cpp_browser' });
    const loaded = settingsToDomain({ dto: SettingsSchemaDto.parse(JSON.parse(JSON.stringify(dto))) });
    expect(loaded.endpoint).toStrictEqual(settings.endpoint);
    expect(loaded.experimental?.llamaCppBrowser?.contextTokens).toBe(8192);
  });

  it('migrates endpoints in image translation settings without promoting the surrounding experimental feature', () => {
    const value = ExperimentalImageGenerationTranslationOverrideSchemaDto.parse({
      endpoint: { type: 'experimental_type', experimental: { endpoint: { type: 'llama_cpp_browser' } } },
      modelId: 'translator.gguf',
      lmParameters: { temperature: 0.2 },
    });
    const domain = imageGenerationTranslationToDomain({ value });
    expect(domain?.endpoint).toStrictEqual({ type: 'llama_cpp_browser' });
    const serialized = JSON.parse(JSON.stringify(imageGenerationTranslationToDto({ value: domain })));
    expect(serialized.endpoint).toStrictEqual({ type: 'llama_cpp_browser' });
    expect(serialized.modelId).toBe('translator.gguf');
    expect(serialized.lmParameters.temperature).toBe(0.2);
    expect(value.endpoint?.type).toBe('experimental_type');
  });

  it('retains the browser-provided endpoint as a distinct experimental alternative', () => {
    expect(endpointToDomain({ dto: EndpointSchemaDto.parse({ type: 'experimental_type', experimental: { endpoint: { type: 'browser_provided_lm' } } }) })).toEqual({ type: 'browser_provided_lm' });
  });

  it('accepts llama_cpp_browser as a top-level storage variant', () => {
    expect(EndpointSchemaDto.safeParse({ type: 'llama_cpp_browser' }).success).toBe(true);
  });

  it('preserves unsupported behavior for an unknown experimental subtype', () => {
    expect(endpointToDomain({ dto: EndpointSchemaDto.parse({ type: 'experimental_type', experimental: { endpoint: { type: 'future_browser_engine' } } }) }).type).toBe('unsupported_experimental_endpoint');
  });

  it.each(['browser_provided_lm', 'llama_cpp_browser'])('does not read the former flat identifier: %s', type => {
    const dto = EndpointSchemaDto.parse({ type: 'experimental_type', experimental: { type } });
    expect(endpointToDomain({ dto })).toEqual({ type: 'unsupported_experimental_endpoint', persistedType: undefined });
  });

  it('does not fall back to a former identifier when the structured endpoint is unreadable', () => {
    const dto = EndpointSchemaDto.parse({ type: 'experimental_type', experimental: { type: 'browser_provided_lm', endpoint: { type: 'future_engine' } } });
    expect(endpointToDomain({ dto })).toEqual({ type: 'unsupported_experimental_endpoint', persistedType: 'future_engine' });
  });

  it('continues writing the browser-provided LM through its experimental envelope', () => {
    const dto = endpointToDto({ endpoint: { type: 'browser_provided_lm' } });
    expect(dto).toStrictEqual({ type: 'experimental_type', experimental: { endpoint: { type: 'browser_provided_lm' }, unreadable: undefined } });
    expect(endpointToDomain({ dto: EndpointSchemaDto.parse(dto) })).toEqual({ type: 'browser_provided_lm' });
  });

  it.each([undefined, {}, { type: 42 }, 'not an endpoint'])('keeps malformed endpoint payloads unsupported: %j', endpoint => {
    const dto = EndpointSchemaDto.parse({ type: 'experimental_type', experimental: { endpoint } });
    expect(endpointToDomain({ dto })).toEqual({ type: 'unsupported_experimental_endpoint', persistedType: undefined });
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
