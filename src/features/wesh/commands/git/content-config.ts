import type { WeshCommandContext } from "@/features/wesh/types";
import { readWorktreeContentConfig } from "./config";
import type { GitRepository } from "./repository";

export async function resolveContentConfigForContext({ context, repository }: {
    context: WeshCommandContext;
    repository: GitRepository;
}) {
  return readWorktreeContentConfig({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    cwd: context.cwd,
    env: context.env,
  });
}

export const TEST_ONLY = {
};
