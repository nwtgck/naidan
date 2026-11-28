import { describe, expect, it } from 'vitest';
import { EndpointDtoSchema } from './dto';

import {
  ExperimentalExperimentalTypeEndpointDtoSchema,
  ExperimentalSettingsDtoSchema,
  optionalExperimentalFieldDtoSchema,
} from './experimental.dto';

const OptionalExperimentalSettingsDtoSchema = optionalExperimentalFieldDtoSchema({
  schema: ExperimentalSettingsDtoSchema,
});

describe('optionalExperimentalFieldDtoSchema', () => {
  it('keeps the experimental field optional', () => {
    expect(OptionalExperimentalSettingsDtoSchema.parse(undefined)).toBeUndefined();
  });

  it('keeps readable fields and records only unreadable entries', () => {
    const parsed = OptionalExperimentalSettingsDtoSchema.parse({
      markdownRendering: 'future_renderer',
      toolConfigPersistence: 'enabled',
      fakeLm: 'enabled',
      sidebarSendMessageReorder: 'move_sent_chat',
    });

    expect(parsed).toEqual({
      locale: undefined,
      markdownRendering: undefined,
      toolConfigPersistence: 'enabled',
      fakeLm: 'enabled',
      sidebarSendMessageReorder: 'move_sent_chat',
      globalSearch: undefined,
      llamaCppBrowser: undefined,
      browserImageGeneration: undefined,
      liveConversationModelId: undefined,
    });
    expect(parsed?.unreadable).toEqual({
      markdownRendering: 'future_renderer',
    });
    expect(Object.keys(parsed ?? {})).not.toContain('unreadable');
    expect(JSON.stringify(parsed)).toBe('{"toolConfigPersistence":"enabled","fakeLm":"enabled","sidebarSendMessageReorder":"move_sent_chat"}');
  });

  it('records persisted disabled fake LM mode as unreadable while defaulting it to disabled in the domain mapper', () => {
    const parsed = OptionalExperimentalSettingsDtoSchema.parse({
      fakeLm: 'disabled',
    });

    expect(parsed).toEqual({
      locale: undefined,
      markdownRendering: undefined,
      toolConfigPersistence: undefined,
      fakeLm: undefined,
      sidebarSendMessageReorder: undefined,
      globalSearch: undefined,
      llamaCppBrowser: undefined,
      browserImageGeneration: undefined,
      liveConversationModelId: undefined,
    });
    expect(parsed?.unreadable).toEqual({
      fakeLm: 'disabled',
    });
  });

  it('records unknown experimental entries as unreadable', () => {
    const parsed = OptionalExperimentalSettingsDtoSchema.parse({
      sidebarSendMessageReorder: 'disabled',
      futureFeature: { enabled: true },
    });

    expect(parsed).toEqual({
      locale: undefined,
      markdownRendering: undefined,
      toolConfigPersistence: undefined,
      fakeLm: undefined,
      sidebarSendMessageReorder: 'disabled',
      globalSearch: undefined,
      llamaCppBrowser: undefined,
      browserImageGeneration: undefined,
      liveConversationModelId: undefined,
    });
    expect(parsed?.unreadable).toEqual({
      futureFeature: { enabled: true },
    });
  });

  it('records non-object experimental values under _root', () => {
    const parsed = OptionalExperimentalSettingsDtoSchema.parse('future-experimental-shape');

    expect(parsed).toEqual({
      locale: undefined,
      markdownRendering: undefined,
      toolConfigPersistence: undefined,
      fakeLm: undefined,
      sidebarSendMessageReorder: undefined,
      globalSearch: undefined,
      llamaCppBrowser: undefined,
      browserImageGeneration: undefined,
      liveConversationModelId: undefined,
    });
    expect(parsed?.unreadable).toEqual({
      _root: 'future-experimental-shape',
    });
  });

  it('accepts supported persisted locales and records unsupported values as unreadable', () => {
    for (const locale of ['en', 'ja', 'zh-Hans', 'pt-BR', 'es', 'ko', 'de'] as const) {
      const supported = OptionalExperimentalSettingsDtoSchema.parse({ locale });
      expect(supported?.locale).toBe(locale);
    }

    const unsupported = OptionalExperimentalSettingsDtoSchema.parse({ locale: 'fr' });
    expect(unsupported?.locale).toBeUndefined();
    expect(unsupported?.unreadable).toEqual({ locale: 'fr' });
  });

  it('accepts partial Global Search settings and arbitrary numeric context sizes', () => {
    const parsed = OptionalExperimentalSettingsDtoSchema.parse({
      globalSearch: {
        scope: 'current_thread',
        previewContextSize: 4,
      },
    });

    expect(parsed?.globalSearch).toEqual({
      scope: 'current_thread',
      roleFilter: undefined,
      previewMode: undefined,
      previewContextSize: 4,
    });
  });

  it('accepts full Global Search settings', () => {
    const parsed = OptionalExperimentalSettingsDtoSchema.parse({
      globalSearch: {
        scope: 'all',
        roleFilter: 'assistant',
        previewMode: 'peek',
        previewContextSize: 'full',
      },
    });

    expect(parsed?.globalSearch).toEqual({
      scope: 'all',
      roleFilter: 'assistant',
      previewMode: 'peek',
      previewContextSize: 'full',
    });
  });

  it('records an invalid Global Search object as unreadable', () => {
    const parsed = OptionalExperimentalSettingsDtoSchema.parse({
      globalSearch: {
        scope: 'future_scope',
        previewContextSize: 7,
      },
    });

    expect(parsed?.globalSearch).toBeUndefined();
    expect(parsed?.unreadable).toEqual({
      globalSearch: {
        scope: 'future_scope',
        previewContextSize: 7,
      },
    });
  });
});

describe('experimental development CSP storage', () => {
  it('materializes a missing metaCsp as undefined and omits it from JSON', () => {
    const parsed = ExperimentalSettingsDtoSchema.parse({ locale: 'ja' });
    expect(Object.hasOwn(parsed, 'metaCsp')).toBe(true);
    expect(parsed.metaCsp).toBeUndefined();
    expect(JSON.parse(JSON.stringify(parsed))).toEqual({ locale: 'ja' });
  });

  it.each(['', ' ', "connect-src 'self'; x-future-rule v2", 'not CSP syntax'])('stores a string structurally without treating %j as a clear operation', metaCsp => {
    const parsed = OptionalExperimentalSettingsDtoSchema.parse({ locale: 'ja', metaCsp });
    expect(parsed?.metaCsp).toBe(metaCsp);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual({ locale: 'ja', metaCsp });
    expect(parsed?.unreadable).toBeUndefined();
  });

  it.each([null, false, 42, [], {}])('isolates an unreadable metaCsp %j without losing unrelated fields', metaCsp => {
    const parsed = OptionalExperimentalSettingsDtoSchema.parse({ locale: 'ja', metaCsp, naidanRpc: 'enabled' });
    expect(parsed?.locale).toBe('ja');
    expect(parsed?.naidanRpc).toBe('enabled');
    expect(parsed?.metaCsp).toBeUndefined();
    expect(parsed?.unreadable).toEqual({ metaCsp });
    expect(Object.keys(parsed ?? {})).not.toContain('unreadable');
    expect(JSON.parse(JSON.stringify(parsed))).toEqual({ locale: 'ja', naidanRpc: 'enabled' });
  });
});

describe('ExperimentalExperimentalTypeEndpointDtoSchema', () => {
  const schema = ExperimentalExperimentalTypeEndpointDtoSchema;

  it('keeps browser_provided_lm strongly typed', () => {
    expect(schema.parse({ endpoint: { type: 'browser_provided_lm' } }))
      .toStrictEqual({ endpoint: { type: 'browser_provided_lm' } });
  });

  it.each(['browser_provided_lm', 'llama_cpp_browser'])('reads %s through the endpoint envelope', type => {
    expect(EndpointDtoSchema.parse({ type: 'experimental_type', experimental: { endpoint: { type } } }))
      .toStrictEqual({ type: 'experimental_type', experimental: { endpoint: { type } } });
  });

  it.each([undefined, null, 'invalid', [], {}, { type: 42 }, { type: 'llama_cpp_browser' }, { endpoint: { type: 42 } }])(
    'isolates an unreadable experimental payload: %j', experimental => {
      const parsed = EndpointDtoSchema.parse({ type: 'experimental_type', experimental });
      expect(parsed.type).toBe('experimental_type');
      if (parsed.type !== 'experimental_type') {
        throw new Error('Unexpected endpoint type');
      }
      expect(parsed.experimental?.endpoint).toBeUndefined();
    },
  );

  it('keeps an absent experimental payload optional', () => {
    expect(EndpointDtoSchema.parse({ type: 'experimental_type' }))
      .toStrictEqual({ type: 'experimental_type' });
  });

  it('isolates an unknown endpoint identifier without invalidating the envelope', () => {
    const parsed = EndpointDtoSchema.parse({
      type: 'experimental_type',
      experimental: { endpoint: { type: 'future_browser_ai' } },
    });
    expect(parsed).toStrictEqual({ type: 'experimental_type', experimental: { endpoint: undefined } });
    if (parsed.type !== 'experimental_type') {
      throw new Error('Unexpected endpoint type');
    }
    expect(parsed.experimental?.unreadable).toEqual({ endpoint: { type: 'future_browser_ai' } });
  });
});

describe('ephemeral live conversation selection', () => {
  it('accepts a model id and keeps old settings readable when it is absent', () => {
    expect(OptionalExperimentalSettingsDtoSchema.parse({})?.liveConversationModelId).toBeUndefined();
    const parsed = OptionalExperimentalSettingsDtoSchema.parse({ liveConversationModelId: 'host/LiquidAI/LFM3-Audio-2B:Q4_K_M' });
    expect(parsed?.liveConversationModelId).toBe('host/LiquidAI/LFM3-Audio-2B:Q4_K_M');
    expect(JSON.parse(JSON.stringify(parsed))).toEqual({ liveConversationModelId: 'host/LiquidAI/LFM3-Audio-2B:Q4_K_M' });
  });

  it('quarantines an unreadable selection without discarding other experimental fields', () => {
    const parsed = OptionalExperimentalSettingsDtoSchema.parse({ liveConversationModelId: { future: 'format' }, fakeLm: 'enabled' });
    expect(parsed?.liveConversationModelId).toBeUndefined();
    expect(parsed?.fakeLm).toBe('enabled');
    expect(parsed?.unreadable?.liveConversationModelId).toEqual({ future: 'format' });
  });
});
