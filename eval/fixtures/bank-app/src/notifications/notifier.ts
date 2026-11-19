import { appendFile } from "node:fs/promises";

const LOG_FILE = "transfers.log";

/** Records completed transfers in a log file. Retries up to three times. */
export async function onTransferCompleted(payload: unknown): Promise<void> {
  const line = `${new Date().toISOString()} ${JSON.stringify(payload)}\n`;
  let attempts = 0;
  while (attempts < 3) {
    try {
      await appendFile(LOG_FILE, line);
      return;
    } catch {
      attempts++;
    }
  }
}
