export function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function naturalSort(arr: readonly string[]): string[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...arr].sort(collator.compare);
}
