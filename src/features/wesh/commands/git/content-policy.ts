import type { WeshCommandContext } from "@/features/wesh/types";
import { assertSupportedSafeCrlfClean, assertSupportedWorktreeContentConfig, readCommandConfigEntries, readEffectiveConfig, readGlobalConfigEntries } from "./config";
import type { GitConfig } from "./config";
import { discoverRepositoryFromContext } from "./repository";

async function readRepositoryContentPolicyConfig({ context }: {
  context: WeshCommandContext;
}): Promise<GitConfig> {
  const repository = await discoverRepositoryFromContext({ context });
  return readEffectiveConfig({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    env: context.env,
  });
}

async function readCloneContentPolicyConfig({ context }: {
  context: WeshCommandContext;
}): Promise<GitConfig> {
  const config: GitConfig = new Map();
  for (const entry of await readGlobalConfigEntries({ files: context.files, homePath: context.env.get('HOME') ?? '/' })) {
    config.set(entry.key, entry.value);
  }
  for (const entry of readCommandConfigEntries({ env: context.env })) config.set(entry.key, entry.value);
  return config;
}

function assertContentPolicyConfig({ config, cleanMutation }: {
  config: GitConfig;
  cleanMutation: boolean;
}): void {
  assertSupportedWorktreeContentConfig({ config });
  if (cleanMutation) assertSupportedSafeCrlfClean({ config });
}

export async function assertSupportedRepositoryContentPolicy({ context, cleanMutation = false }: {
  context: WeshCommandContext;
  cleanMutation?: boolean;
}): Promise<void> {
  assertContentPolicyConfig({
    config: await readRepositoryContentPolicyConfig({ context }),
    cleanMutation,
  });
}

export async function assertSupportedCloneContentPolicy({ context }: {
  context: WeshCommandContext;
}): Promise<void> {
  assertContentPolicyConfig({
    config: await readCloneContentPolicyConfig({ context }),
    cleanMutation: false,
  });
}

export const TEST_ONLY = {
};
