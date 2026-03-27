import { describe, it, expect } from 'vitest';
import { HarmonyStreamParser } from './gpt-oss-harmony';

describe('HarmonyStreamParser', () => {
  it('parses a reasoning response split across analysis and final channels', () => {
    const parser = new HarmonyStreamParser();
    const tokens = [
      '<|start|>',
      'assistant',
      '<|channel|>',
      'analysis',
      '<|message|>',
      'Need to compute 2 + 2.',
      '<|end|>',
      '<|start|>',
      'assistant',
      '<|channel|>',
      'final',
      '<|message|>',
      '4',
      '<|return|>',
    ];

    const deltas = parser.pushMany(tokens);
    const result = parser.getResult();

    expect(result.done).toBe(true);
    expect(result.messages).toEqual([
      {
        role: 'assistant',
        channel: 'analysis',
        content: 'Need to compute 2 + 2.',
        endReason: 'end',
      },
      {
        role: 'assistant',
        channel: 'final',
        content: '4',
        endReason: 'return',
      },
    ]);
    expect(deltas.filter(delta => delta.type === 'done')).toEqual([
      { type: 'done', messageIndex: 0, endReason: 'end', isDone: false },
      { type: 'done', messageIndex: 1, endReason: 'return', isDone: true },
    ]);
  });

  it('parses tool calls with commentary recipient and constrain metadata', () => {
    const parser = new HarmonyStreamParser();
    const tokens = [
      '<|start|>',
      'assistant to=functions.get_weather',
      '<|channel|>',
      'commentary',
      '<|constrain|>',
      'json',
      '<|message|>',
      '{"location":"Tokyo"}',
      '<|call|>',
    ];

    parser.pushMany(tokens);

    expect(parser.messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        channel: 'commentary',
        recipient: 'functions.get_weather',
        contentType: '<|constrain|>json',
        content: '{"location":"Tokyo"}',
        endReason: 'call',
      }),
    ]);
  });

  it('parses recipient when the channel header carries to=...', () => {
    const parser = new HarmonyStreamParser();
    const tokens = [
      '<|start|>',
      'assistant',
      '<|channel|>',
      'commentary to=functions.get_weather',
      '<|constrain|>',
      'json',
      '<|message|>',
      '{"latitude":48.8566,"longitude":2.3522}',
      '<|call|>',
    ];

    parser.pushMany(tokens);

    expect(parser.messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        channel: 'commentary',
        recipient: 'functions.get_weather',
        contentType: '<|constrain|>json',
        content: '{"latitude":48.8566,"longitude":2.3522}',
        endReason: 'call',
      }),
    ]);
  });

  it('supports an implicit assistant start when the stream begins with a channel token', () => {
    const parser = new HarmonyStreamParser();
    const tokens = [
      '<|channel|>',
      'final',
      '<|message|>',
      'Hello',
      '<|return|>',
    ];

    parser.pushMany(tokens);

    expect(parser.messages).toEqual([
      {
        role: 'assistant',
        channel: 'final',
        content: 'Hello',
        endReason: 'return',
      },
    ]);
    expect(parser.getResult().done).toBe(true);
  });

  it('parses tool-authored commentary messages addressed to the assistant', () => {
    const parser = new HarmonyStreamParser();
    const tokens = [
      '<|start|>',
      'lookup_weather to=assistant',
      '<|channel|>',
      'commentary',
      '<|message|>',
      '{"temp_c":26}',
      '<|end|>',
    ];

    parser.pushMany(tokens);

    expect(parser.messages).toEqual([
      {
        role: 'lookup_weather',
        channel: 'commentary',
        recipient: 'assistant',
        content: '{"temp_c":26}',
        endReason: 'end',
      },
    ]);
  });

  it('trims trailing whitespace only when a message closes', () => {
    const parser = new HarmonyStreamParser();
    const tokens = [
      '<|start|>',
      'assistant',
      '<|channel|>',
      'final',
      '<|message|>',
      'Hello   ',
    ];

    parser.pushMany(tokens);
    expect(parser.messages[0]).toEqual(expect.objectContaining({
      content: 'Hello   ',
      endReason: 'pending',
    }));

    parser.push('<|return|>');
    expect(parser.messages[0]).toEqual(expect.objectContaining({
      content: 'Hello',
      endReason: 'return',
    }));
  });

  it('ignores additional tokens after return', () => {
    const parser = new HarmonyStreamParser();
    const tokens = [
      '<|start|>',
      'assistant',
      '<|channel|>',
      'final',
      '<|message|>',
      'Done',
      '<|return|>',
      '<|start|>',
      'assistant',
      '<|channel|>',
      'analysis',
      '<|message|>',
      'should be ignored',
    ];

    parser.pushMany(tokens);

    expect(parser.messages).toEqual([
      {
        role: 'assistant',
        channel: 'final',
        content: 'Done',
        endReason: 'return',
      },
    ]);
  });
});
