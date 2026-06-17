import { describe, expect, it, vi } from 'vitest';
import { toChatId } from '@/models/ids';
import { ChoicesArgsSchema, createChoicesTool, renderChoicesResult } from './index';
import { zodToJsonSchema } from '@/utils/llm-tools';

const validArgs = {
  prompt: 'Choose a direction',
  choices: ['Implementation', 'Tests', 'Alternatives'],
};

describe('choices tool', () => {
  it('accepts a prompt and two or more distinct single-line choices', () => {
    expect(ChoicesArgsSchema.parse(validArgs)).toEqual(validArgs);
    expect(() => ChoicesArgsSchema.parse({
      prompt: 'Choose',
      choices: ['Only one'],
    })).toThrow();
    expect(() => ChoicesArgsSchema.parse({
      prompt: 'Choose',
      choices: ['Same', 'Same'],
    })).toThrow('Choices must be unique.');
    expect(() => ChoicesArgsSchema.parse({
      prompt: 'Choose',
      choices: [`\
First line
Second line`, 'Other'],
    })).toThrow('Choices must be single-line text.');
  });

  it('publishes a strict JSON schema for LLM tool calls', () => {
    expect(zodToJsonSchema({ schema: ChoicesArgsSchema })).toMatchObject({
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
        },
        choices: {
          type: 'array',
          minItems: 2,
          maxItems: 10,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            pattern: String.raw`^[^\r\n]+$`,
          },
        },
      },
      required: ['prompt', 'choices'],
      additionalProperties: false,
    });
  });

  it('waits for the selection and returns its zero-based index and full text as Markdown', async () => {
    const requestChoice = vi.fn().mockResolvedValue({ index: 1 });
    const tool = createChoicesTool({
      chatId: toChatId({ raw: 'chat-a' }),
      requestChoice,
    });

    const result = await tool.execute({
      args: validArgs,
      signal: undefined,
      approvalContext: undefined,
      onEvent: undefined,
    });

    expect(requestChoice).toHaveBeenCalledWith({
      chatId: toChatId({ raw: 'chat-a' }),
      prompt: validArgs.prompt,
      choices: validArgs.choices,
      signal: undefined,
    });
    expect(result).toEqual({
      status: 'success',
      content: `\
Zero-based Index: 1
Tests`,
    });
  });

  it('returns invalid_arguments when called directly with invalid input', async () => {
    const tool = createChoicesTool({
      chatId: toChatId({ raw: 'chat-a' }),
      requestChoice: vi.fn(),
    });

    const result = await tool.execute({
      args: {
        prompt: 'Choose',
        choices: ['Only one'],
      },
      signal: undefined,
      approvalContext: undefined,
      onEvent: undefined,
    });

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('invalid_arguments');
    }
  });

  it('renders the selected full text without replacing Markdown characters', () => {
    expect(renderChoicesResult({
      index: 0,
      choice: '**Use the API**',
    })).toBe(`\
Zero-based Index: 0
**Use the API**`);
  });
});
