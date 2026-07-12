import {
  EncryptedObjectTransactionSchemaDto,
  type EncryptedObjectTransactionDto,
} from '@/00-storage/00-dto/encryption.dto';
import { decodeBase64Url, encodeBase64Url } from './base64-url';
import {
  EncryptedObjectStore,
  type EncryptedObjectLocator,
} from './encrypted-object-store';
import { createEncryptionOpaqueId } from './encryption-key-manager';
import { runWithEncryptedStorageLock } from './encrypted-storage-lock';

const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });


export type EncryptedObjectMutationOperation =
  | {
      readonly type: 'write',
      readonly locator: EncryptedObjectLocator,
      readonly plaintext: Uint8Array,
    }
  | {
      readonly type: 'delete',
      readonly locator: EncryptedObjectLocator,
    };

export interface PreparedEncryptedObjectMutation {
  readonly operations: readonly EncryptedObjectMutationOperation[],
  readonly cleanupAfterCommit?: () => Promise<void>,
  readonly cleanupAfterFailure?: () => Promise<void>,
}
function transactionToBytes({ transaction }: {
  transaction: EncryptedObjectTransactionDto,
}): Uint8Array {
  return UTF8.encode(JSON.stringify(transaction));
}

function transactionFromBytes({ bytes }: { bytes: Uint8Array }): EncryptedObjectTransactionDto {
  return EncryptedObjectTransactionSchemaDto.parse(
    JSON.parse(UTF8_DECODER.decode(bytes)),
  );
}

function transactionsEqual({
  left,
  right,
}: {
  left: EncryptedObjectTransactionDto,
  right: EncryptedObjectTransactionDto,
}): boolean {
  if (
    left.id !== right.id
    || left.scopeId !== right.scopeId
    || left.operations.length !== right.operations.length
  ) {
    return false;
  }
  for (let index = 0; index < left.operations.length; index += 1) {
    const leftOperation = left.operations[index];
    const rightOperation = right.operations[index];
    if (
      leftOperation === undefined
      || rightOperation === undefined
      || leftOperation.type !== rightOperation.type
      || leftOperation.namespace !== rightOperation.namespace
      || leftOperation.key !== rightOperation.key
    ) {
      return false;
    }
    if (
      leftOperation.type === 'write'
      && (
        rightOperation.type !== 'write'
        || leftOperation.plaintextBase64Url !== rightOperation.plaintextBase64Url
      )
    ) {
      return false;
    }
  }
  return true;
}

export class EncryptedObjectTransactionCoordinator {
  constructor({
    objectStore,
    scopeId,
    lockName,
  }: {
    objectStore: EncryptedObjectStore,
    scopeId: string,
    lockName: string,
  }) {
    this.objectStore = objectStore;
    this.scopeId = scopeId;
    this.lockName = lockName;
  }

  private readonly objectStore: EncryptedObjectStore;
  private readonly scopeId: string;
  private readonly lockName: string;

  async read<T>({ run }: { run: () => Promise<T> }): Promise<T> {
    while (true) {
      const attempt = await runWithEncryptedStorageLock({
        lockName: this.lockName,
        mode: 'shared',
        run: async () => {
          if (await this.readJournal() !== undefined) {
            return { type: 'recovery_required' as const };
          }
          return {
            type: 'value' as const,
            value: await run(),
          };
        },
      });
      switch (attempt.type) {
      case 'value':
        return attempt.value;
      case 'recovery_required':
        break;
      default: {
        const _ex: never = attempt;
        throw new Error(`Unhandled encrypted transaction read attempt: ${String(_ex)}`);
      }
      }

      // The journal check and the caller's read must happen under the same
      // shared lease. Releasing an exclusive recovery lease before acquiring
      // a shared read lease would leave a gap where another tab could persist
      // a journal, stop mid-apply, and expose a partial mutation to this read.
      await runWithEncryptedStorageLock({
        lockName: this.lockName,
        mode: 'exclusive',
        run: async () => {
          await this.recoverPendingTransaction();
        },
      });
    }
  }

  async mutate<T>({
    prepare,
    result,
  }: {
    prepare: () => Promise<PreparedEncryptedObjectMutation>,
    result: () => Promise<T>,
  }): Promise<T> {
    return await this.runExclusive({
      run: async () => {
        const prepared = await prepare();
        let preparedObjectsMayBeDeleted = true;
        let materialized = prepared.operations.length === 0;
        try {
          if (prepared.operations.length > 0) {
            const transaction: EncryptedObjectTransactionDto = {
              id: createEncryptionOpaqueId(),
              scopeId: this.scopeId,
              operations: prepared.operations.map(operation => {
                switch (operation.type) {
                case 'write':
                  return {
                    type: 'write' as const,
                    namespace: operation.locator.namespace,
                    key: operation.locator.key,
                    plaintextBase64Url: encodeBase64Url({ bytes: operation.plaintext }),
                  };
                case 'delete':
                  return {
                    type: 'delete' as const,
                    namespace: operation.locator.namespace,
                    key: operation.locator.key,
                  };
                default: {
                  const _ex: never = operation;
                  throw new Error(`Unhandled encrypted object mutation operation: ${String(_ex)}`);
                }
                }
              }),
            };
            try {
              await this.writeJournal({ transaction });
              preparedObjectsMayBeDeleted = false;
            } catch (error) {
              const journalStatus = await this.inspectJournalAfterWriteFailure({
                expected: transaction,
              });
              switch (journalStatus) {
              case 'matching':
                // OPFS may have committed the writable-stream replacement even
                // when close reports an error. A byte-equivalent authenticated
                // journal is durable intent, so complete it instead of reporting
                // failure for an operation that would appear after recovery.
                preparedObjectsMayBeDeleted = false;
                break;
              case 'missing':
                preparedObjectsMayBeDeleted = true;
                throw error;
              case 'ambiguous':
                preparedObjectsMayBeDeleted = false;
                throw error;
              default: {
                const _ex: never = journalStatus;
                throw new Error(`Unhandled journal write status: ${String(_ex)}`);
              }
              }
            }
            try {
              await this.applyTransaction({ transaction });
              await this.deleteJournal();
              materialized = true;
            } catch (error) {
              // The encrypted journal contains the complete authenticated mutation
              // and is the logical commit point. Returning failure after that point
              // would allow a caller to retry an operation which must later appear
              // when the journal is recovered. Leave materialization pending and
              // let every subsequent read or mutation roll it forward first.
              console.warn('Encrypted object mutation is committed and pending recovery', error);
            }
          }
        } catch (error) {
          if (preparedObjectsMayBeDeleted) {
            await prepared.cleanupAfterFailure?.();
          }
          throw error;
        }
        if (materialized) {
          try {
            await prepared.cleanupAfterCommit?.();
          } catch (error) {
            // The logical commit is already durable. Cleanup failures only leave
            // unreachable encrypted objects and must not turn success into failure.
            console.warn('Encrypted object mutation cleanup failed', error);
          }
        }
        return await result();
      },
    });
  }

  async runExclusive<T>({
    run,
  }: {
    run: () => Promise<T>,
  }): Promise<T> {
    return await runWithEncryptedStorageLock({
      lockName: this.lockName,
      mode: 'exclusive',
      run: async () => {
        await this.recoverPendingTransaction();
        return await run();
      },
    });
  }

  async recover(): Promise<void> {
    await runWithEncryptedStorageLock({
      lockName: this.lockName,
      mode: 'exclusive',
      run: async () => {
        await this.recoverPendingTransaction();
      },
    });
  }

  private getJournalLocator(): EncryptedObjectLocator {
    return {
      namespace: 'object_transaction_journal',
      key: this.scopeId,
    };
  }

  private async readJournal(): Promise<EncryptedObjectTransactionDto | undefined> {
    const bytes = await this.objectStore.read({ locator: this.getJournalLocator() });
    if (bytes === undefined) {
      return undefined;
    }
    const transaction = transactionFromBytes({ bytes });
    if (transaction.scopeId !== this.scopeId) {
      throw new Error('Encrypted object transaction scope does not match its locator');
    }
    return transaction;
  }

  private async writeJournal({
    transaction,
  }: {
    transaction: EncryptedObjectTransactionDto,
  }): Promise<void> {
    await this.objectStore.write({
      locator: this.getJournalLocator(),
      plaintext: transactionToBytes({ transaction }),
    });
  }

  private async deleteJournal(): Promise<void> {
    await this.objectStore.delete({ locator: this.getJournalLocator() });
  }

  private async inspectJournalAfterWriteFailure({
    expected,
  }: {
    expected: EncryptedObjectTransactionDto,
  }): Promise<'matching' | 'missing' | 'ambiguous'> {
    try {
      const persisted = await this.readJournal();
      if (persisted === undefined) {
        return 'missing';
      }
      return transactionsEqual({ left: persisted, right: expected })
        ? 'matching'
        : 'ambiguous';
    } catch {
      // An unreadable result is ambiguous rather than proof that the write did
      // not commit. Leaking unreachable prepared objects is safer than deleting
      // data that a durable journal may still reference.
      return 'ambiguous';
    }
  }

  private async recoverPendingTransaction(): Promise<void> {
    const transaction = await this.readJournal();
    if (transaction === undefined) {
      return;
    }
    await this.applyTransaction({ transaction });
    await this.deleteJournal();
  }

  private async applyTransaction({
    transaction,
  }: {
    transaction: EncryptedObjectTransactionDto,
  }): Promise<void> {
    for (const operation of transaction.operations) {
      switch (operation.type) {
      case 'write':
        await this.objectStore.write({
          locator: {
            namespace: operation.namespace,
            key: operation.key,
          },
          plaintext: decodeBase64Url({ value: operation.plaintextBase64Url }),
        });
        break;
      case 'delete':
        await this.objectStore.delete({
          locator: {
            namespace: operation.namespace,
            key: operation.key,
          },
        });
        break;
      default: {
        const _ex: never = operation;
        throw new Error(`Unhandled encrypted object transaction operation: ${String(_ex)}`);
      }
      }
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  transactionFromBytes,
  transactionToBytes,
  transactionsEqual,
};
