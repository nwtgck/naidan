import { describe, expect, it } from 'vitest';

import {
  ExperimentalSettingsSchemaDto,
  optionalExperimentalFieldSchemaDto,
} from './experimental.dto';

const OptionalExperimentalSettingsSchemaDto = optionalExperimentalFieldSchemaDto({
  schema: ExperimentalSettingsSchemaDto,
});

describe('optionalExperimentalFieldSchemaDto', () => {
  it('keeps the experimental field optional', () => {
    expect(OptionalExperimentalSettingsSchemaDto.parse(undefined)).toBeUndefined();
  });

  it('keeps readable fields and records only unreadable entries', () => {
    const parsed = OptionalExperimentalSettingsSchemaDto.parse({
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
    });
    expect(parsed?.unreadable).toEqual({
      markdownRendering: 'future_renderer',
    });
    expect(Object.keys(parsed ?? {})).not.toContain('unreadable');
    expect(JSON.stringify(parsed)).toBe('{"toolConfigPersistence":"enabled","fakeLm":"enabled","sidebarSendMessageReorder":"move_sent_chat"}');
  });

  it('records persisted disabled fake LM mode as unreadable while defaulting it to disabled in the domain mapper', () => {
    const parsed = OptionalExperimentalSettingsSchemaDto.parse({
      fakeLm: 'disabled',
    });

    expect(parsed).toEqual({
      locale: undefined,
      markdownRendering: undefined,
      toolConfigPersistence: undefined,
      fakeLm: undefined,
      sidebarSendMessageReorder: undefined,
      globalSearch: undefined,
    });
    expect(parsed?.unreadable).toEqual({
      fakeLm: 'disabled',
    });
  });

  it('records unknown experimental entries as unreadable', () => {
    const parsed = OptionalExperimentalSettingsSchemaDto.parse({
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
    });
    expect(parsed?.unreadable).toEqual({
      futureFeature: { enabled: true },
    });
  });

  it('records non-object experimental values under _root', () => {
    const parsed = OptionalExperimentalSettingsSchemaDto.parse('future-experimental-shape');

    expect(parsed).toEqual({
      locale: undefined,
      markdownRendering: undefined,
      toolConfigPersistence: undefined,
      fakeLm: undefined,
      sidebarSendMessageReorder: undefined,
      globalSearch: undefined,
    });
    expect(parsed?.unreadable).toEqual({
      _root: 'future-experimental-shape',
    });
  });

  it('accepts supported persisted locales and records unsupported values as unreadable', () => {
    const supported = OptionalExperimentalSettingsSchemaDto.parse({ locale: 'ja' });
    expect(supported?.locale).toBe('ja');

    const unsupported = OptionalExperimentalSettingsSchemaDto.parse({ locale: 'fr' });
    expect(unsupported?.locale).toBeUndefined();
    expect(unsupported?.unreadable).toEqual({ locale: 'fr' });
  });

  it('accepts partial Global Search settings and arbitrary numeric context sizes', () => {
    const parsed = OptionalExperimentalSettingsSchemaDto.parse({
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
    const parsed = OptionalExperimentalSettingsSchemaDto.parse({
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
    const parsed = OptionalExperimentalSettingsSchemaDto.parse({
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
