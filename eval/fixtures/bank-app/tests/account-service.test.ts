import { describe, expect, it } from "vitest";
import { AccountService } from "../src/accounts/account-service.js";
import { InMemoryAccountRepository } from "../src/accounts/in-memory-account-repository.js";
import { ForbiddenError } from "../src/accounts/account.js";
import { EventBus } from "../src/events/event-bus.js";

async function setup() {
  const repo = new InMemoryAccountRepository();
  await repo.save({ id: "a", ownerId: "alice", balanceCents: 10_000, currency: "USD" });
  await repo.save({ id: "b", ownerId: "bob", balanceCents: 0, currency: "USD" });
  return { repo, service: new AccountService(repo, new EventBus()) };
}

describe("AccountService", () => {
  it("transfer-success", async () => {
    const { service } = await setup();
    const result = await service.transferFunds("alice", "a", "b", 2_500);
    expect(result.fromBalanceCents).toBe(7_500);
    expect(result.toBalanceCents).toBe(2_500);
  });

  it("transfer-unauthorized", async () => {
    const { service } = await setup();
    await expect(service.transferFunds("bob", "a", "b", 100)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("transfer-insufficient-funds", async () => {
    const { service } = await setup();
    // Fails today: the service does not check the balance (planted problem).
    await expect(service.transferFunds("alice", "a", "b", 1_000_000)).rejects.toThrow();
  });
});
