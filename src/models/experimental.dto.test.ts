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
      markdownRendering: undefined,
      toolConfigPersistence: 'enabled',
      fakeLm: 'enabled',
      sidebarSendMessageReorder: 'move_sent_chat',
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
      markdownRendering: undefined,
      toolConfigPersistence: undefined,
      fakeLm: undefined,
      sidebarSendMessageReorder: undefined,
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
      markdownRendering: undefined,
      toolConfigPersistence: undefined,
      fakeLm: undefined,
      sidebarSendMessageReorder: 'disabled',
    });
    expect(parsed?.unreadable).toEqual({
      futureFeature: { enabled: true },
    });
  });

  it('records non-object experimental values under _root', () => {
    const parsed = OptionalExperimentalSettingsSchemaDto.parse('future-experimental-shape');

    expect(parsed).toEqual({
      markdownRendering: undefined,
      toolConfigPersistence: undefined,
      fakeLm: undefined,
      sidebarSendMessageReorder: undefined,
    });
    expect(parsed?.unreadable).toEqual({
      _root: 'future-experimental-shape',
    });
  });
});
