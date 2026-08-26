type PermissionClass = 'user' | 'group' | 'other';
type SymbolicOperation = '+' | '-' | '=';

const CLASS_MASKS: Readonly<Record<PermissionClass, number>> = {
  user: 0o700,
  group: 0o070,
  other: 0o007,
};

const CLASS_SHIFTS: Readonly<Record<PermissionClass, number>> = {
  user: 6,
  group: 3,
  other: 0,
};

const SPECIAL_CLASS_MASKS: Readonly<Record<PermissionClass, number>> = {
  user: 0o4000,
  group: 0o2000,
  other: 0o1000,
};

function classesFromWho({ who }: { who: string }): readonly PermissionClass[] {
  const classes: PermissionClass[] = [];
  if (who.includes('a') || who.includes('u')) classes.push('user');
  if (who.includes('a') || who.includes('g')) classes.push('group');
  if (who.includes('a') || who.includes('o')) classes.push('other');
  return classes;
}

function permissionTriplet({
  permissions,
  mode,
}: {
  permissions: string;
  mode: number;
}): number | undefined {
  let triplet = 0;
  for (const character of permissions) {
    switch (character) {
    case 'r':
      triplet |= 0o4;
      break;
    case 'w':
      triplet |= 0o2;
      break;
    case 'x':
      triplet |= 0o1;
      break;
    case 'X':
      if ((mode & 0o111) !== 0) triplet |= 0o1;
      break;
    case 'u':
      triplet |= (mode & CLASS_MASKS.user) >> CLASS_SHIFTS.user;
      break;
    case 'g':
      triplet |= (mode & CLASS_MASKS.group) >> CLASS_SHIFTS.group;
      break;
    case 'o':
      triplet |= (mode & CLASS_MASKS.other) >> CLASS_SHIFTS.other;
      break;
    case 's':
    case 't':
      break;
    default:
      return undefined;
    }
  }
  return triplet;
}

function specialPermissionMask({
  classes,
  permissions,
}: {
  classes: readonly PermissionClass[];
  permissions: string;
}): number {
  let mask = 0;
  if (permissions.includes('s')) {
    if (classes.includes('user')) mask |= SPECIAL_CLASS_MASKS.user;
    if (classes.includes('group')) mask |= SPECIAL_CLASS_MASKS.group;
  }
  if (permissions.includes('t') && classes.includes('other')) {
    mask |= SPECIAL_CLASS_MASKS.other;
  }
  return mask;
}

function applySymbolicOperation({
  who,
  operation,
  permissions,
  mode,
  umask,
  allowSpecialBits,
}: {
  who: string;
  operation: SymbolicOperation;
  permissions: string;
  mode: number;
  umask: number;
  allowSpecialBits: boolean;
}): number | undefined {
  if (!/^[rwxXugost]*$/u.test(permissions)) return undefined;
  if (!allowSpecialBits && /[st]/u.test(permissions)) return undefined;

  const explicitWho = who.length > 0;
  const classes = explicitWho
    ? classesFromWho({ who })
    : (['user', 'group', 'other'] as const);
  const triplet = permissionTriplet({ permissions, mode });
  if (triplet === undefined) return undefined;

  let affectedMask = 0;
  let permissionMask = 0;
  let specialAffectedMask = 0;
  for (const permissionClass of classes) {
    const shift = CLASS_SHIFTS[permissionClass];
    affectedMask |= CLASS_MASKS[permissionClass];
    permissionMask |= triplet << shift;
    specialAffectedMask |= SPECIAL_CLASS_MASKS[permissionClass];
  }

  if (!explicitWho) {
    affectedMask &= ~umask;
    permissionMask &= ~umask;
  }

  const specialMask = allowSpecialBits
    ? specialPermissionMask({ classes, permissions })
    : 0;

  switch (operation) {
  case '+':
    return mode | permissionMask | specialMask;
  case '-':
    return mode & ~permissionMask & ~specialMask;
  case '=':
    return (mode & ~affectedMask & ~specialAffectedMask) | permissionMask | specialMask;
  default: {
    const _ex: never = operation;
    throw new Error(`Unhandled symbolic mode operation: ${_ex}`);
  }
  }
}

function applySymbolicClause({
  clause,
  mode,
  umask,
  allowSpecialBits,
}: {
  clause: string;
  mode: number;
  umask: number;
  allowSpecialBits: boolean;
}): number | undefined {
  const match = clause.match(/^([ugoa]*)(.*)$/u);
  if (match === null) return undefined;

  const who = match[1] ?? '';
  const operations = match[2] ?? '';
  if (operations.length === 0) return undefined;

  let nextMode = mode;
  let offset = 0;
  while (offset < operations.length) {
    const operation = operations[offset];
    if (operation !== '+' && operation !== '-' && operation !== '=') return undefined;
    offset += 1;

    const permissionStart = offset;
    while (offset < operations.length) {
      const character = operations[offset];
      if (character === '+' || character === '-' || character === '=') break;
      offset += 1;
    }

    const permissions = operations.slice(permissionStart, offset);
    const applied = applySymbolicOperation({
      who,
      operation,
      permissions,
      mode: nextMode,
      umask,
      allowSpecialBits,
    });
    if (applied === undefined) return undefined;
    nextMode = applied;
  }

  return nextMode;
}

export function parseFilePermissionMode({
  value,
  initialMode,
  umask,
  allowSpecialBits,
}: {
  value: string;
  initialMode: number;
  umask: number;
  allowSpecialBits: boolean;
}): { ok: true; mode: number } | { ok: false; specialBits: boolean } {
  if (/^[0-7]{1,4}$/u.test(value)) {
    const mode = Number.parseInt(value, 8);
    if ((mode & ~0o777) !== 0 && !allowSpecialBits) return { ok: false, specialBits: true };
    return { ok: true, mode };
  }

  if (value.length === 0) return { ok: false, specialBits: false };
  const clauses = value.split(',');
  if (clauses.some(clause => clause.length === 0)) {
    return { ok: false, specialBits: false };
  }
  if (!allowSpecialBits && /[st]/u.test(value)) return { ok: false, specialBits: true };

  let mode = initialMode & (allowSpecialBits ? 0o7777 : 0o777);
  for (const clause of clauses) {
    const nextMode = applySymbolicClause({ clause, mode, umask, allowSpecialBits });
    if (nextMode === undefined) return { ok: false, specialBits: false };
    mode = nextMode & (allowSpecialBits ? 0o7777 : 0o777);
  }
  return { ok: true, mode };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
