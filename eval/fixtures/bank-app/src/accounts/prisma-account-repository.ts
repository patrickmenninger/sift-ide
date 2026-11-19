import type { PrismaClient } from "@prisma/client";
import { NotFoundError, type Account } from "./account.js";
import type { AccountRepository } from "./account-repository.js";

export class PrismaAccountRepository implements AccountRepository {
  constructor(private readonly db: PrismaClient) {}

  async getAccount(id: string): Promise<Account> {
    const record = await this.db.account.findUnique({ where: { id } });
    if (record === null) {
      throw new NotFoundError(`Account ${id} does not exist`);
    }
    return record;
  }

  async listByOwner(ownerId: string): Promise<Account[]> {
    return this.db.account.findMany({ where: { ownerId } });
  }

  async save(account: Account): Promise<void> {
    await this.db.account.update({
      where: { id: account.id },
      data: { balanceCents: account.balanceCents },
    });
  }
}
