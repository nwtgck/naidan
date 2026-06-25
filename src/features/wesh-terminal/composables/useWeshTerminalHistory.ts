export function createWeshTerminalHistory() {
  const entries: string[] = [];
  let cursor: number | undefined = undefined;
  let draftBeforeNavigation = '';

  function record({ script }: { script: string }) {
    const trimmed = script.trim();
    if (trimmed.length === 0) return;
    if (entries.at(-1) !== trimmed) {
      entries.push(trimmed);
    }
    cursor = undefined;
    draftBeforeNavigation = '';
  }

  function previous({ draft }: { draft: string }): string | undefined {
    if (entries.length === 0) return undefined;
    if (cursor === undefined) {
      cursor = entries.length - 1;
      draftBeforeNavigation = draft;
    } else {
      cursor = Math.max(0, cursor - 1);
    }
    return entries[cursor];
  }

  function next(): string | undefined {
    if (cursor === undefined) return undefined;
    if (cursor >= entries.length - 1) {
      cursor = undefined;
      return draftBeforeNavigation;
    }
    cursor += 1;
    return entries[cursor];
  }

  function resetNavigation() {
    cursor = undefined;
    draftBeforeNavigation = '';
  }

  return {
    record,
    previous,
    next,
    resetNavigation,
  };
}
