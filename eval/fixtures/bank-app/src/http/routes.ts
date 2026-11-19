import express, { type Request, type Response } from "express";
import { ForbiddenError, NotFoundError, ValidationError } from "../accounts/account.js";
import type { AccountService } from "../accounts/account-service.js";
import type { AuthService } from "../auth/auth-service.js";

export function statusFor(error: unknown): number {
  switch (true) {
    case error instanceof ValidationError:
      return 400;
    case error instanceof ForbiddenError:
      return 403;
    case error instanceof NotFoundError:
      return 404;
    default:
      return 500;
  }
}

export function createRouter(accounts: AccountService, auth: AuthService) {
  const router = express.Router();

  router.post("/transfers", async (req: Request, res: Response) => {
    try {
      const user = await auth.authenticate(req.header("authorization"));
      const { fromId, toId, amountCents } = req.body as { fromId: string; toId: string; amountCents: number };
      const confirmation = await accounts.transferFunds(user.id, fromId, toId, amountCents);
      res.json(confirmation);
    } catch (error) {
      res.status(statusFor(error)).json({ error: String(error) });
    }
  });

  router.get("/accounts/:id/balance", (req, res) => getBalanceHandler(accounts, req, res));

  return router;
}

export async function getBalanceHandler(accounts: AccountService, req: Request, res: Response) {
  const balanceCents = await accounts.getBalance(req.params.id ?? "");
  res.json({ balanceCents });
}
