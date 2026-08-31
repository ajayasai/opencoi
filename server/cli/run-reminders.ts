import "dotenv/config";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { runReminderCycle } from "../services/reminders.js";
import { ensureApiSchema } from "../services/schema.js";

const config = loadConfig();
const database = openDatabase(config.databasePath);
ensureApiSchema(database);
try {
  const result = await runReminderCycle(database, config);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.failed > 0) process.exitCode = 1;
} finally {
  database.close();
}
