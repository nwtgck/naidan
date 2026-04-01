import { describe, expect, it } from 'vitest';
import { buildQwen3_5ToolSystemPrompt } from './transformers-js-qwen3_5-tools';

describe('buildQwen3_5ToolSystemPrompt', () => {
  it('renders tool definitions without passing raw JSON schema into the template', () => {
    const prompt = buildQwen3_5ToolSystemPrompt({
      tools: [
        {
          type: 'function',
          function: {
            name: 'search_files',
            description: 'Search files by glob.',
            parameters: {
              type: 'object',
              properties: {
                pattern: { type: 'string', description: 'Glob pattern.' },
                paths: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Paths to search.',
                },
              },
              required: ['pattern'],
            },
          },
        },
      ],
    });

    expect(prompt).toContain('Tool: search_files');
    expect(prompt).toContain('- pattern: string (required) - Glob pattern.');
    expect(prompt).toContain('- paths: array<string> (optional) - Paths to search.');
    expect(prompt).toContain('<function=TOOL_NAME>');
  });
});
