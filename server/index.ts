import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { bootstrapOrganization, openDatabase } from "./db.js";
import { hashPassword } from "./security.js";
import { runReminderCycle } from "./services/reminders.js";
import { ensureApiSchema } from "./services/schema.js";
import { FileSystemDocumentStore } from "./storage.js";

const start = async (): Promise<void> => {
  const config = loadConfig();
  const database = openDatabase(config.databasePath);
  ensureApiSchema(database);
  if (config.bootstrap) {
    const passwordHash = await hashPassword(config.bootstrap.administratorPassword);
    bootstrapOrganization(database, {
      organizationName: config.bootstrap.organizationName,
      organizationSlug: config.bootstrap.organizationSlug,
      administratorName: config.bootstrap.administratorName,
      administratorEmail: config.bootstrap.administratorEmail,
      administratorPasswordHash: passwordHash,
    });
  }
  const documentStore = new FileSystemDocumentStore(config.uploadDirectory);
  const app = createApp({ config, database, documentStore });
  const server = createServer(app);
  server.listen(config.port, config.host, () => {
    const listenerHost = config.host === "0.0.0.0" ? "localhost" : config.host;
    process.stdout.write(
      `OpenCOI API listening on http://${listenerHost}:${config.port} (browser origin ${config.appOrigin})\n`,
    );
  });

  let reminderRunning = false;
  const runReminders = async () => {
    if (reminderRunning || !config.remindersEnabled) return;
    reminderRunning = true;
    try {
      await runReminderCycle(database, config);
    } catch (error) {
      process.stderr.write(
        `Reminder cycle failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } finally {
      reminderRunning = false;
    }
  };
  if (config.remindersEnabled) {
    void runReminders();
    setInterval(() => void runReminders(), config.reminderPollMs).unref();
  }

  const shutdown = (signal: string) => {
    process.stdout.write(`Received ${signal}; shutting down\n`);
    server.close(() => {
      database.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
};

void start().catch((error) => {
  process.stderr.write(
    `OpenCOI failed to start: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
