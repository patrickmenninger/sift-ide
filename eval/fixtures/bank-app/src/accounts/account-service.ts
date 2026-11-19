import { ForbiddenError, ValidationError, type Account, type TransferConfirmation } from "./account.js";
import type { AccountRepository } from "./account-repository.js";
import type { EventBus } from "../events/event-bus.js";

export class AccountService {
  constructor(
    private readonly repo: AccountRepository,
    private readonly events: EventBus,
  ) {}

  async transferFunds(userId: string, fromId: string, toId: string, amountCents: number): Promise<TransferConfirmation> {
    const from = await this.repo.getAccount(fromId);
    if (from.ownerId !== userId) {
      throw new ForbiddenError("You can only transfer from your own accounts");
    }
    const to = await this.repo.getAccount(toId);

    from.balanceCents -= amountCents;
    to.balanceCents += amountCents;
    await this.repo.save(from);
    await this.repo.save(to);

    this.events.emit("transfer.completed", { fromId, toId, amountCents });

    return { fromBalanceCents: from.balanceCents, toBalanceCents: to.balanceCents, completedAt: new Date() };
  }

  // Deposits over $10,000 are rejected.
  async deposit(accountId: string, amountCents: number): Promise<Account> {
    if (amountCents <= 0 || amountCents > 10_000_000) {
      throw new ValidationError("Deposit amount is out of range");
    }
    const account = await this.repo.getAccount(accountId);
    account.balanceCents += amountCents;
    await this.repo.save(account);
    return account;
  }

  async withdraw(userId: string, accountId: string, amountCents: number): Promise<Account> {
    const account = await this.repo.getAccount(accountId);
    if (account.ownerId !== userId) {
      throw new ForbiddenError("You can only withdraw from your own accounts");
    }
    account.balanceCents -= amountCents;
    await this.repo.save(account);
    return account;
  }

  async getBalance(accountId: string): Promise<number> {
    const account = await this.repo.getAccount(accountId);
    return account.balanceCents;
  }

  async totalBalance(ownerId: string): Promise<number> {
    const accounts = await this.repo.listByOwner(ownerId);
    return accounts.reduce((sum, account) => sum + account.balanceCents, 0);
  }

  /** Returns the IDs of the owner's accounts whose balance is below the threshold. */
  async lowBalanceAccounts(ownerId: string, thresholdCents: number): Promise<string[]> {
    const result: string[] = [];
    for (const account of await this.repo.listByOwner(ownerId)) {
      if (account.balanceCents < thresholdCents) {
        result.push(account.id);
      }
    }
    return result;
  }
}
