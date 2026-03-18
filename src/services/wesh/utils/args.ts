export function parseFlags({
  args,
  booleanFlags,
  stringFlags,
}: {
  args: string[];
  booleanFlags: string[];
  stringFlags: string[];
}): {
  flags: Record<string, string | boolean>;
  positional: string[];
  unknown: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const unknown: string[] = [];
  const booleanSet = new Set(booleanFlags);
  const stringSet = new Set(stringFlags);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg.startsWith('--')) {
      const longFlag = arg.slice(2);
      const [key, value] = longFlag.split('=');

      if (key === undefined) continue;

      if (stringSet.has(key)) {
        if (value !== undefined) {
          flags[key] = value;
        } else if (i + 1 < args.length) {
          const nextArg = args[++i];
          flags[key] = nextArg !== undefined ? nextArg : '';
        } else {
          flags[key] = '';
        }
      } else if (booleanSet.has(key)) {
        flags[key] = value !== undefined ? value : true;
      } else {
        unknown.push(key);
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      const shortFlags = arg.slice(1);
      for (let j = 0; j < shortFlags.length; j++) {
        const char = shortFlags[j];
        if (char === undefined) continue;

        if (stringSet.has(char)) {
          const value = shortFlags.slice(j + 1);
          if (value) {
            flags[char] = value;
            break;
          } else if (i + 1 < args.length) {
            const nextArg = args[++i];
            flags[char] = nextArg !== undefined ? nextArg : '';
            break;
          } else {
            flags[char] = '';
            break;
          }
        } else if (booleanSet.has(char)) {
          flags[char] = true;
        } else {
          unknown.push(char);
        }
      }
      continue;
    }

    positional.push(arg);
  }

  return { flags, positional, unknown };
}
