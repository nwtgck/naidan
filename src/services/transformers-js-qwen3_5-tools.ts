import type { WorkerToolDefinition } from './transformers-js.types';

function jsonSchemaToQwen3_5Type({ schema }: { schema: Record<string, unknown> }): string {
  const type = schema.type;
  switch (type) {
  case 'string':
    return 'string';
  case 'number':
  case 'integer':
    return 'number';
  case 'boolean':
    return 'boolean';
  case 'array': {
    const items = schema.items as Record<string, unknown> | undefined;
    return items ? `array<${jsonSchemaToQwen3_5Type({ schema: items })}>` : 'array<unknown>';
  }
  case 'object':
    return 'object';
  default:
    return 'unknown';
  }
}

function formatQwen3_5ToolParameters({ parameters }: { parameters: Record<string, unknown> }): string {
  const properties = parameters.properties as Record<string, Record<string, unknown>> | undefined;
  const required = new Set((parameters.required as string[] | undefined) ?? []);

  if (!properties || Object.keys(properties).length === 0) {
    return 'This tool takes no parameters.';
  }

  return Object.entries(properties)
    .map(([name, schema]) => {
      const description = typeof schema.description === 'string' ? schema.description : '';
      const suffix = required.has(name) ? 'required' : 'optional';
      return `- ${name}: ${jsonSchemaToQwen3_5Type({ schema })} (${suffix})${description ? ` - ${description}` : ''}`;
    })
    .join('\n');
}

export function buildQwen3_5ToolSystemPrompt({ tools }: { tools: WorkerToolDefinition[] }): string {
  const toolBlocks = tools.map((tool) => {
    const description = tool.function.description || 'No description provided.';
    const parameters = formatQwen3_5ToolParameters({ parameters: tool.function.parameters });

    return [
      `Tool: ${tool.function.name}`,
      `Description: ${description}`,
      'Parameters:',
      parameters,
    ].join('\n');
  }).join('\n\n');

  return `\
You may call tools when they are needed.

When calling a tool, respond with exactly this XML format and no surrounding prose:
<tool_call>
<function=TOOL_NAME>
<parameter=PARAM_NAME>VALUE</parameter>
</function>
</tool_call>

Available tools:
${toolBlocks}`;
}
