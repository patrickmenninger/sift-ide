export interface Account {
  id: string;
  ownerId: string;
  /** Balance in whole cents, to avoid floating-point rounding. */
  balanceCents: number;
  currency: string;
}

export interface TransferConfirmation {
  fromBalanceCents: number;
  toBalanceCents: number;
  completedAt: Date;
}

export interface User {
  id: string;
  name: string;
}

export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}
export class ValidationError extends Error {}
