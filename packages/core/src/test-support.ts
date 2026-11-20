import type { SiftFile, SiftUnit } from "./schema.js";

/** A realistic `.sift` file (design §6.1) for tests. Not exported from the package. */
export function sampleSiftFile(): SiftFile {
  return {
    sift: 0,
    source: "src/accounts/account-service.ts",
    language: "typescript",
    fileHash: "4be1c09a7d2e55f0",
    units: [transferUnit(), liteUnit()],
  };
}

export function transferUnit(): SiftUnit {
  return {
    id: "u_7f3k2a6q",
    symbol: "AccountService.transferFunds",
    kind: "method",
    status: "generated",
    bodyHash: "9c1e04ab33d0e871",
    contextHash: "1a02ffe0c4b98d12",
    generatedBy: { provider: "claude-code", model: "claude-opus-5-5", prompt: "describe@1", belowTier: false },
    summary: "Moves money from one of the requesting user's accounts to another account and returns a confirmation of the transfer.",
    inputs: [
      { name: "userId", type: "string", meaning: "ID of the user requesting the transfer." },
      { name: "amountCents", type: "number", meaning: "Amount to move, in cents." },
    ],
    returns: { type: "Promise<TransferConfirmation>", meaning: "The new balances of both accounts and the time of the transfer." },
    effects: ["db.read", "db.write"],
    steps: [
      { id: "s_q2w6", text: "Get the source account from the database.", covers: ["0"], calls: ["u_q2x4p6de"], effects: ["db.read"], steps: [] },
      {
        id: "s_h3k2",
        kind: "if",
        text: "If the source account does not belong to the requesting user,",
        covers: ["1"],
        calls: [],
        effects: [],
        steps: [{ id: "s_m7p2", text: 'stop with a "forbidden" error.', covers: ["1.then.0"], calls: [], effects: ["throws"], steps: [] }],
      },
      {
        id: "s_b2v7",
        text: "Save the source account with its balance reduced by the amount, then save the destination account with its balance increased by the amount.",
        covers: ["3", "4", "5", "6"],
        calls: ["u_z3c6m2kf", "ext:@prisma/client#Prisma.AccountDelegate.update"],
        effects: ["db.write"],
        steps: [],
      },
    ],
    warnings: [
      {
        id: "w_2d4s",
        kind: "missing-transaction",
        text: "The two balance updates are not inside a database transaction. If the second update fails, money is removed from the source account without arriving in the destination account.",
        steps: ["s_b2v7"],
      },
    ],
    tests: [],
  };
}

export function liteUnit(): SiftUnit {
  return {
    id: "u_m2c6d2aa",
    symbol: "formatCents",
    kind: "function",
    lite: true,
    status: "generated",
    bodyHash: "0e7d2c91aa4f3b60",
    summary: 'Formats a number of cents as a dollar string such as "$1,250.00".',
    inputs: [{ name: "cents", type: "number", meaning: "Amount in cents." }],
    returns: { type: "string", meaning: "The formatted amount." },
    effects: [],
    steps: [],
    warnings: [],
    tests: [],
  };
}
