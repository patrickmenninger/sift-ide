// Older reporting code that has not been converted to TypeScript.

export function summarize(accounts) {
  const owners = new Set(accounts.map((a) => a.ownerId));
  const total = accounts.reduce((sum, a) => sum + a.balanceCents, 0);
  return { accountCount: accounts.length, ownerCount: owners.size, totalCents: total };
}

export function printSummary(summary, out) {
  out.write(`Accounts: ${summary.accountCount}\n`);
  out.write(`Owners: ${summary.ownerCount}\n`);
  out.write(`Total: ${summary.totalCents} cents\n`);
}
