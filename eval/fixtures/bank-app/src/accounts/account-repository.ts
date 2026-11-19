import type { Account } from "./account.js";

/** Storage for accounts. */
export interface AccountRepository {
  getAccount(id: string): Promise<Account>;
  listByOwner(ownerId: string): Promise<Account[]>;
  save(account: Account): Promise<void>;
}
