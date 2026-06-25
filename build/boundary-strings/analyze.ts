const stringsImportPattern = /import\s*\{([^}]*)\}\s*from\s*['"]@\/strings['"]/g;
const supportedBindings = new Set(['strings', 'stringsAsync']);

function collectImportedBindings({ sourceCode }: {
  sourceCode: string;
}): readonly string[] {
  const bindings = new Set<string>();
  for (const match of sourceCode.matchAll(stringsImportPattern)) {
    const specifiers = match[1];
    if (specifiers === undefined) {
      continue;
    }
    for (const rawSpecifier of specifiers.split(',')) {
      const specifier = rawSpecifier.trim();
      const specifierMatch = /^(strings|stringsAsync)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/.exec(specifier);
      const importedName = specifierMatch?.[1];
      const localName = specifierMatch?.[2];
      if (importedName === undefined || !supportedBindings.has(importedName)) {
        continue;
      }
      bindings.add(localName ?? importedName);
    }
  }
  return [...bindings];
}

export function collectBoundaryStringKeys({ sourceCode }: {
  sourceCode: string;
}): readonly string[] {
  const keys = new Set<string>();
  for (const binding of collectImportedBindings({ sourceCode })) {
    const directStringAccessPattern = new RegExp(
      `\\b${binding}\\.([A-Za-z][A-Za-z0-9]*__[a-z][a-z0-9_]*)\\b`,
      'g',
    );
    for (const match of sourceCode.matchAll(directStringAccessPattern)) {
      const key = match[1];
      if (key !== undefined) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort();
}
