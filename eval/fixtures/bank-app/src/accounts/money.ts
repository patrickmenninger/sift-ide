/** Formats a number of cents as a dollar string such as "$1,250.00". */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

export const toCents = (dollars: number): number => Math.round(dollars * 100);

/**
 * Applies monthly interest to a balance for a number of months.
 * Interest is rounded down to whole cents each month.
 */
export function applyMonthlyInterest(balanceCents: number, annualRate: number, months: number): number {
  if (months <= 0) {
    return balanceCents;
  }
  const interest = Math.floor((balanceCents * annualRate) / 12);
  return applyMonthlyInterest(balanceCents + interest, annualRate, months - 1);
}
