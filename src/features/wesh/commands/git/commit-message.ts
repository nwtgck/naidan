export function cleanupMessage({ text }: {
  text: string;
}): string {
  const lines: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/[\t ]+$/u, '');
    if (line.length === 0) {
      if (lines.length === 0 || lines.at(-1) === '') continue;
      lines.push('');
      continue;
    }
    lines.push(line);
  }
  if (lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}

export function appendMessageParagraph({ current, value }: {
  current: string | undefined;
  value: string;
}): string {
  return current === undefined ? value : `${current}\n\n${value}`;
}

export function firstLine({ text }: {
    text: string;
}): string {
  return text.split('\n', 1)[0] ?? '';
}

export const TEST_ONLY = {
};
