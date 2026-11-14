export function multiPromptImageExamples({ prompts }: { prompts: readonly [string, string, string] }): { yaml: string; jsonl: string } {
  const requests = prompts.map(prompt => ({ prompt, count: 1 }));
  return {
    yaml: requests.map(request => `\
prompt: ${JSON.stringify(request.prompt)}
count: ${request.count}`).join('\n---\n'),
    jsonl: requests.map(request => JSON.stringify(request)).join('\n'),
  };
}
