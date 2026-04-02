export declare const STANDALONE_WORKER_CLIENT_FACADES: readonly string[]

export declare function createStandaloneWorkerClientAliases({
  resolvePath,
}: {
  resolvePath: (relativePath: string) => string
}): Record<string, string>
