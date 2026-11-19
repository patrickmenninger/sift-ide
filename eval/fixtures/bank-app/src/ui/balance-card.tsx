import type { Account } from "../accounts/account.js";
import { formatCents } from "../accounts/money.js";

export function BalanceCard({ account, highlight }: { account: Account; highlight: boolean }) {
  const label = highlight ? "Low balance" : "Balance";
  return (
    <div className={highlight ? "card card--warning" : "card"}>
      <span>{label}</span>
      <strong>{formatCents(account.balanceCents)}</strong>
    </div>
  );
}
