import express from "express";
import { AccountService } from "./accounts/account-service.js";
import { PrismaAccountRepository } from "./accounts/prisma-account-repository.js";
import { AuthService } from "./auth/auth-service.js";
import { prisma } from "./db.js";
import { EventBus } from "./events/event-bus.js";
import { createRouter } from "./http/routes.js";
import { onTransferCompleted } from "./notifications/notifier.js";

const PORT = 3000;

const bus = new EventBus();
bus.on("transfer.completed", onTransferCompleted);

const accounts = new AccountService(new PrismaAccountRepository(prisma), bus);
const app = express();
app.use(createRouter(accounts, new AuthService()));

app.listen(PORT, () => {
  console.log(`bank-app listening on ${PORT}`);
});
