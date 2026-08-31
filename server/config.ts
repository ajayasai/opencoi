import { isAbsolute, resolve } from "node:path";

export type RuntimeEnvironment = "development" | "test" | "production";

export interface BootstrapConfig {
  organizationName: string;
  organizationSlug: string;
  administratorName: string;
  administratorEmail: string;
  administratorPassword: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
}

export type OidcClientAuthMethod = "client_secret_basic" | "client_secret_post";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  clientAuthMethod: OidcClientAuthMethod;
  organizationSlug: string;
  displayName: string;
  transactionTtlMs: number;
}

export interface AppConfig {
  environment: RuntimeEnvironment;
  host: string;
  port: number;
  /** Number of known reverse-proxy hops whose forwarding headers may be trusted. */
  trustProxyHops: number;
  appOrigin: string;
  dataDirectory: string;
  databasePath: string;
  uploadDirectory: string;
  maxUploadBytes: number;
  sessionTtlMs: number;
  uploadLinkTtlMs: number;
  sessionCookieName: string;
  secureCookies: boolean;
  tokenPepper?: string;
  oidc: OidcConfig | null;
  smtp: SmtpConfig | null;
  remindersEnabled: boolean;
  reminderPollMs: number;
  bootstrap: BootstrapConfig | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

const readString = (environment: Environment, name: string, fallback?: string): string => {
  const value = environment[name]?.trim();
  if (value) {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new ConfigError(`${name} is required`);
};

const readOptionalString = (environment: Environment, name: string): string | undefined => {
  const value = environment[name]?.trim();
  return value || undefined;
};

const readInteger = (
  environment: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const raw = environment[name]?.trim();
  if (!raw) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const readBoolean = (environment: Environment, name: string, fallback: boolean): boolean => {
  const raw = environment[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  throw new ConfigError(`${name} must be true or false`);
};

const toAbsolutePath = (workingDirectory: string, value: string): string =>
  isAbsolute(value) ? value : resolve(workingDirectory, value);

const validateOrigin = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError("APP_ORIGIN must be an absolute http(s) URL");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.origin !== value) {
    throw new ConfigError("APP_ORIGIN must contain only an http(s) origin");
  }
  return parsed.origin;
};

const slugify = (value: string): string => {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);
  if (!slug) {
    throw new ConfigError("BOOTSTRAP_ORG_SLUG could not be derived");
  }
  return slug;
};

const readBootstrap = (environment: Environment): BootstrapConfig | null => {
  const configuredValues = [
    "BOOTSTRAP_ORG_NAME",
    "BOOTSTRAP_ORG_SLUG",
    "BOOTSTRAP_ADMIN_NAME",
    "BOOTSTRAP_ADMIN_EMAIL",
    "BOOTSTRAP_ADMIN_PASSWORD",
  ].filter((name) => Boolean(environment[name]?.trim()));

  if (configuredValues.length === 0) {
    return null;
  }

  const organizationName = readString(environment, "BOOTSTRAP_ORG_NAME");
  const email = readString(environment, "BOOTSTRAP_ADMIN_EMAIL").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ConfigError("BOOTSTRAP_ADMIN_EMAIL must be a valid email address");
  }
  const password = readString(environment, "BOOTSTRAP_ADMIN_PASSWORD");
  if (Buffer.byteLength(password, "utf8") < 12) {
    throw new ConfigError("BOOTSTRAP_ADMIN_PASSWORD must be at least 12 bytes");
  }

  const explicitSlug = readOptionalString(environment, "BOOTSTRAP_ORG_SLUG");
  const organizationSlug = explicitSlug ? slugify(explicitSlug) : slugify(organizationName);

  return {
    organizationName,
    organizationSlug,
    administratorName: readString(environment, "BOOTSTRAP_ADMIN_NAME", "OpenCOI Administrator"),
    administratorEmail: email,
    administratorPassword: password,
  };
};

const readSmtp = (environment: Environment): SmtpConfig | null => {
  const host = readOptionalString(environment, "SMTP_HOST");
  if (!host) {
    return null;
  }

  const user = readOptionalString(environment, "SMTP_USER");
  const password = readOptionalString(environment, "SMTP_PASSWORD");
  if (Boolean(user) !== Boolean(password)) {
    throw new ConfigError("SMTP_USER and SMTP_PASSWORD must be provided together");
  }

  return {
    host,
    port: readInteger(environment, "SMTP_PORT", 587, 1, 65_535),
    secure: readBoolean(environment, "SMTP_SECURE", false),
    user,
    password,
    from: readString(environment, "SMTP_FROM", "OpenCOI <no-reply@localhost>"),
  };
};

const readOidc = (environment: Environment, runtime: RuntimeEnvironment): OidcConfig | null => {
  const names = [
    "OIDC_ISSUER",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_ORGANIZATION_SLUG",
  ] as const;
  const configured = names.filter((name) => Boolean(environment[name]?.trim()));
  if (configured.length === 0) {
    return null;
  }
  if (configured.length !== names.length) {
    throw new ConfigError(`${names.join(", ")} must be provided together`);
  }

  const issuerValue = readString(environment, "OIDC_ISSUER");
  let issuer: URL;
  try {
    issuer = new URL(issuerValue);
  } catch {
    throw new ConfigError("OIDC_ISSUER must be an absolute URL");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]).has(issuer.hostname);
  if (
    !["https:", "http:"].includes(issuer.protocol) ||
    (issuer.protocol !== "https:" && (runtime === "production" || !loopback)) ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash
  ) {
    throw new ConfigError(
      "OIDC_ISSUER must be an HTTPS issuer URL (loopback HTTP is allowed outside production)",
    );
  }

  const organizationSlug = readString(environment, "OIDC_ORGANIZATION_SLUG").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(organizationSlug)) {
    throw new ConfigError("OIDC_ORGANIZATION_SLUG must be a valid lowercase organization slug");
  }
  const clientAuthMethod = readString(
    environment,
    "OIDC_CLIENT_AUTH_METHOD",
    "client_secret_basic",
  );
  if (!new Set(["client_secret_basic", "client_secret_post"]).has(clientAuthMethod)) {
    throw new ConfigError(
      "OIDC_CLIENT_AUTH_METHOD must be client_secret_basic or client_secret_post",
    );
  }

  return {
    issuer: issuer.pathname === "/" ? issuer.origin : issuer.href,
    clientId: readString(environment, "OIDC_CLIENT_ID"),
    clientSecret: readString(environment, "OIDC_CLIENT_SECRET"),
    clientAuthMethod: clientAuthMethod as OidcClientAuthMethod,
    organizationSlug,
    displayName: readString(environment, "OIDC_DISPLAY_NAME", "Single sign-on").slice(0, 80),
    transactionTtlMs:
      readInteger(environment, "OIDC_TRANSACTION_TTL_MINUTES", 10, 1, 15) * 60 * 1000,
  };
};

/**
 * Parse and validate runtime configuration without mutating process.env.
 * Passing an explicit environment makes this deterministic in tests and CLIs.
 */
export const loadConfig = (
  environment: Environment = process.env,
  workingDirectory = process.cwd(),
): AppConfig => {
  const runtime = readString(environment, "NODE_ENV", "development");
  if (!["development", "test", "production"].includes(runtime)) {
    throw new ConfigError("NODE_ENV must be development, test, or production");
  }
  const environmentName = runtime as RuntimeEnvironment;
  const port = readInteger(environment, "PORT", 4174, 1, 65_535);
  const dataDirectory = toAbsolutePath(
    workingDirectory,
    readString(environment, "DATA_DIR", "./data"),
  );
  const maxUploadMegabytes = readInteger(environment, "MAX_UPLOAD_MB", 15, 1, 100);
  const sessionTtlHours = readInteger(environment, "SESSION_TTL_HOURS", 12, 1, 24 * 31);
  const uploadLinkTtlDays = readInteger(environment, "UPLOAD_LINK_TTL_DAYS", 14, 1, 365);
  const tokenPepper = readOptionalString(environment, "TOKEN_PEPPER");
  if (tokenPepper && Buffer.byteLength(tokenPepper, "utf8") < 32) {
    throw new ConfigError("TOKEN_PEPPER must be at least 32 bytes when configured");
  }

  const secureCookies = readBoolean(environment, "COOKIE_SECURE", environmentName === "production");
  const appOrigin = validateOrigin(
    readString(environment, "APP_ORIGIN", `http://localhost:${port}`),
  );
  if (environmentName === "production" && secureCookies && !appOrigin.startsWith("https://")) {
    throw new ConfigError(
      "APP_ORIGIN must use https in production when secure cookies are enabled",
    );
  }
  const bootstrap = readBootstrap(environment);
  if (
    environmentName === "production" &&
    bootstrap?.administratorPassword === "replace-with-a-long-unique-password"
  ) {
    throw new ConfigError(
      "BOOTSTRAP_ADMIN_PASSWORD must be changed from the example value in production",
    );
  }

  return {
    environment: environmentName,
    host: readString(environment, "HOST", "127.0.0.1"),
    port,
    trustProxyHops: readInteger(environment, "TRUST_PROXY_HOPS", 0, 0, 8),
    appOrigin,
    dataDirectory,
    databasePath: toAbsolutePath(
      workingDirectory,
      readString(environment, "DATABASE_PATH", resolve(dataDirectory, "opencoi.sqlite")),
    ),
    uploadDirectory: toAbsolutePath(
      workingDirectory,
      readString(environment, "UPLOAD_DIR", resolve(dataDirectory, "uploads")),
    ),
    maxUploadBytes: maxUploadMegabytes * 1024 * 1024,
    sessionTtlMs: sessionTtlHours * 60 * 60 * 1000,
    uploadLinkTtlMs: uploadLinkTtlDays * 24 * 60 * 60 * 1000,
    sessionCookieName: readString(environment, "SESSION_COOKIE_NAME", "opencoi_session"),
    secureCookies,
    tokenPepper,
    oidc: readOidc(environment, environmentName),
    smtp: readSmtp(environment),
    remindersEnabled: readBoolean(environment, "REMINDERS_ENABLED", true),
    reminderPollMs: readInteger(environment, "REMINDER_POLL_MINUTES", 360, 1, 10_080) * 60 * 1000,
    bootstrap,
  };
};
