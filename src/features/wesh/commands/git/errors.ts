export type GitUsageErrorPrefix = 'error' | 'fatal' | 'none';

export class GitUsageError extends Error {
  readonly prefix: GitUsageErrorPrefix;

  constructor({ message, prefix = 'error' }: {
    message: string,
    prefix?: GitUsageErrorPrefix,
  }) {
    super(message);
    this.name = 'GitUsageError';
    this.prefix = prefix;
  }
}

export const TEST_ONLY = {
  GitUsageError,
};
