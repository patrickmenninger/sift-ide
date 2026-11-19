import { NotFoundError, type Account } from "./account.js";
import type { AccountRepository } from "./account-repository.js";

/** Keeps accounts in memory. Used by tests and local development. */
export class InMemoryAccountRepository implements AccountRepository {
  private readonly accounts = new Map<string, Account>();

  async getAccount(id: string): Promise<Account> {
    const account = this.accounts.get(id);
    if (!account) throw new NotFoundError(`Account ${id} does not exist`);
    return { ...account };
  }

  async listByOwner(ownerId: string): Promise<Account[]> {
    return [...this.accounts.values()].filter((a) => a.ownerId === ownerId);
  }

  async save(account: Account): Promise<void> {
    this.accounts.set(account.id, { ...account });
  }
}
