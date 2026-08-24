import type { GitConfig } from './config';
import { getConfigValue } from './config';

export interface GitIdentity {
  name: string,
  email: string,
}

export function resolveGitIdentity({ env, config, role }: {
  env: Map<string, string>,
  config: GitConfig,
  role: 'AUTHOR' | 'COMMITTER',
}): GitIdentity {
  const explicitName = env.get(`GIT_${role}_NAME`);
  const explicitEmail = env.get(`GIT_${role}_EMAIL`);
  const name = explicitName ?? getConfigValue({ config, key: 'user.name' });
  const email = explicitEmail ?? getConfigValue({ config, key: 'user.email' });
  if (name === undefined || email === undefined) {
    throw new Error(`Author identity unknown

*** Please tell me who you are.

Run

  git config user.email "you@example.com"
  git config user.name "Your Name"

to set your account's default identity.`);
  }
  return { name, email };
}

export function resolveGitReflogIdentity({ env, config }: {
  env: Map<string, string>,
  config: GitConfig,
}): GitIdentity {
  const explicitName = env.get('GIT_COMMITTER_NAME');
  const explicitEmail = env.get('GIT_COMMITTER_EMAIL');
  const configuredName = getConfigValue({ config, key: 'user.name' });
  const configuredEmail = getConfigValue({ config, key: 'user.email' });
  const fallbackName = env.get('USER') ?? env.get('LOGNAME') ?? 'wesh';
  const fallbackEmail = env.get('EMAIL') ?? `${fallbackName}@${env.get('HOSTNAME') ?? 'localhost'}`;
  return {
    name: explicitName ?? configuredName ?? fallbackName,
    email: explicitEmail ?? configuredEmail ?? fallbackEmail,
  };
}

function formatTimezone({ date }: { date: Date }): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${Math.floor(absolute / 60).toString().padStart(2, '0')}${(absolute % 60).toString().padStart(2, '0')}`;
}

export function resolveGitTimestamp({ env, role }: {
  env: Map<string, string>,
  role: 'AUTHOR' | 'COMMITTER',
}): string {
  const explicit = env.get(`GIT_${role}_DATE`);
  if (explicit !== undefined) {
    const internal = /^@?([0-9]+)\s+([+-][0-9]{4})$/u.exec(explicit.trim());
    if (internal !== null) return `${internal[1]} ${internal[2]}`;
    const parsed = new Date(explicit);
    if (Number.isNaN(parsed.getTime())) throw new Error(`invalid date format: ${explicit}`);
    const timezoneMatch = /([+-][0-9]{2}):?([0-9]{2})$/u.exec(explicit);
    const timezone = timezoneMatch === null ? '+0000' : `${timezoneMatch[1]}${timezoneMatch[2]}`;
    return `${Math.floor(parsed.getTime() / 1000)} ${timezone}`;
  }
  const now = new Date();
  return `${Math.floor(now.getTime() / 1000)} ${formatTimezone({ date: now })}`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
