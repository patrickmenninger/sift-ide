// Minimal stand-in for the generated Prisma client. Shapes follow the real client.
declare module "@prisma/client" {
  export interface AccountRecord {
    id: string;
    ownerId: string;
    balanceCents: number;
    currency: string;
  }

  export namespace Prisma {
    interface AccountWhereUniqueInput {
      id: string;
    }
    interface AccountWhereInput {
      ownerId?: string;
    }
    interface AccountDelegate {
      findUnique(args: { where: AccountWhereUniqueInput }): Promise<AccountRecord | null>;
      findMany(args: { where: AccountWhereInput }): Promise<AccountRecord[]>;
      create(args: { data: AccountRecord }): Promise<AccountRecord>;
      update(args: { where: AccountWhereUniqueInput; data: Partial<AccountRecord> }): Promise<AccountRecord>;
      delete(args: { where: AccountWhereUniqueInput }): Promise<AccountRecord>;
    }
    type TransactionClient = Omit<PrismaClient, "$transaction">;
  }

  export class PrismaClient {
    account: Prisma.AccountDelegate;
    $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  }
}
