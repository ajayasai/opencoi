import "dotenv/config";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { runCertificateRequestDeliveryCycle } from "../services/certificateRequestDelivery.js";
import { ensureIntegrationSchema } from "../services/integrationSchema.js";

const config = loadConfig();
if (!config.smtp || !config.tokenPepper) {
  throw new Error("SMTP and TOKEN_PEPPER are required for certificate-request delivery");
}
const database = openDatabase(config.databasePath);
ensureIntegrationSchema(database);
const watch = process.argv.includes("--watch");
let stopping = false;

const run = async () => {
  const result = await runCertificateRequestDeliveryCycle(database, config);
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

const stop = () => {
  stopping = true;
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  do {
    await run();
    if (!watch || stopping) break;
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  } while (!stopping);
} finally {
  database.close();
}
