
export function firstLine({ text }: {
    text: string;
}): string {
  return text.split('\n', 1)[0] ?? '';
}

export const TEST_ONLY = {
};
