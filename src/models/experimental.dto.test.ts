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
      sidebarSendMessageReorder: 'move_sent_chat',
    });

    expect(parsed).toEqual({
      markdownRendering: undefined,
      sidebarSendMessageReorder: 'move_sent_chat',
    });
    expect(parsed?.unreadable).toEqual({
      markdownRendering: 'future_renderer',
    });
    expect(Object.keys(parsed ?? {})).not.toContain('unreadable');
    expect(JSON.stringify(parsed)).toBe('{"sidebarSendMessageReorder":"move_sent_chat"}');
  });

  it('records unknown experimental entries as unreadable', () => {
    const parsed = OptionalExperimentalSettingsSchemaDto.parse({
      sidebarSendMessageReorder: 'disabled',
      futureFeature: { enabled: true },
    });

    expect(parsed).toEqual({
      markdownRendering: undefined,
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
      sidebarSendMessageReorder: undefined,
    });
    expect(parsed?.unreadable).toEqual({
      _root: 'future-experimental-shape',
    });
  });
});
