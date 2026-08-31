import "dotenv/config";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { migrateDatabase } from "../migrations.js";
import { runWebhookDeliveryBatch } from "../services/webhooks.js";

const parsePollMs = (): number => {
  const raw = process.env.WEBHOOK_POLL_SECONDS?.trim() ?? "15";
  if (!/^\d+$/.test(raw)) throw new Error("WEBHOOK_POLL_SECONDS must be an integer");
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3_600) {
    throw new Error("WEBHOOK_POLL_SECONDS must be between 1 and 3600");
  }
  return seconds * 1_000;
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  if (!config.tokenPepper) {
    throw new Error("TOKEN_PEPPER is required to decrypt webhook signing secrets");
  }
  const database = openDatabase(config.databasePath, { initialize: false });
  migrateDatabase(database);
  const watch = process.argv.includes("--watch");
  const pollMs = parsePollMs();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    do {
      const result = await runWebhookDeliveryBatch(database, config.tokenPepper, { limit: 50 });
      if (result.claimed > 0 || result.deadLettered > 0 || !watch) {
        process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`);
      }
      if (watch && !stopping) {
        await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
      }
    } while (watch && !stopping);
  } finally {
    database.close();
  }
};

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
