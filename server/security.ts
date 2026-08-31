import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { neutralizeCsvInjection } from "../shared/csv.js";

export { neutralizeCsvInjection, sanitizeCsvCell } from "../shared/csv.js";

const PASSWORD_VERSION = 1;
const PASSWORD_COST = 65_536;
const PASSWORD_BLOCK_SIZE = 8;
const PASSWORD_PARALLELIZATION = 1;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_SALT_LENGTH = 16;
const PASSWORD_MAX_MEMORY = 128 * 1024 * 1024;
const PASSWORD_MIN_BYTES = 12;
const PASSWORD_MAX_BYTES = 1_024;
const TOKEN_BYTES = 32;
// Fixed, non-secret work factor used only when a login identifier has no row.
// The result is ignored; its purpose is to avoid an observable zero-scrypt path.
const DUMMY_PASSWORD_HASH =
  "scrypt$v=1$N=65536,r=8,p=1,l=32$R3H82ohrjliqucw5Ycs58w$2TXy7bVpa8WCrA11p3c51J9SrbwKRWZvI_0RKsFxafc";

export interface SessionTokens {
  sessionToken: string;
  sessionTokenHash: string;
  csrfToken: string;
  csrfTokenHash: string;
}

export interface StoredToken {
  token: string;
  tokenHash: string;
}

const passwordByteLengthIsValid = (password: string): boolean => {
  const length = Buffer.byteLength(password, "utf8");
  return length >= PASSWORD_MIN_BYTES && length <= PASSWORD_MAX_BYTES;
};

const deriveScryptKey = (
  password: string,
  salt: Buffer,
  keyLength: number,
  cost: number,
  blockSize: number,
  parallelization: number,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      {
        N: cost,
        r: blockSize,
        p: parallelization,
        maxmem: Math.max(PASSWORD_MAX_MEMORY, 128 * cost * blockSize + 1024 * 1024),
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
        } else {
          resolve(derivedKey);
        }
      },
    );
  });

/** Hash a human password using a per-password salt and memory-hard scrypt. */
export const hashPassword = async (password: string): Promise<string> => {
  if (!passwordByteLengthIsValid(password)) {
    throw new RangeError(
      `Password must be between ${PASSWORD_MIN_BYTES} and ${PASSWORD_MAX_BYTES} UTF-8 bytes`,
    );
  }
  const salt = randomBytes(PASSWORD_SALT_LENGTH);
  const derivedKey = await deriveScryptKey(
    password,
    salt,
    PASSWORD_KEY_LENGTH,
    PASSWORD_COST,
    PASSWORD_BLOCK_SIZE,
    PASSWORD_PARALLELIZATION,
  );
  return [
    "scrypt",
    `v=${PASSWORD_VERSION}`,
    `N=${PASSWORD_COST},r=${PASSWORD_BLOCK_SIZE},p=${PASSWORD_PARALLELIZATION},l=${PASSWORD_KEY_LENGTH}`,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
};

interface ParsedPasswordHash {
  cost: number;
  blockSize: number;
  parallelization: number;
  keyLength: number;
  salt: Buffer;
  expected: Buffer;
}

const parsePositiveInteger = (value: string | undefined): number | null => {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const parsePasswordHash = (encoded: string): ParsedPasswordHash | null => {
  const [algorithm, versionPart, parametersPart, saltPart, hashPart, extra] = encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    versionPart !== `v=${PASSWORD_VERSION}` ||
    !parametersPart ||
    !saltPart ||
    !hashPart ||
    extra !== undefined
  ) {
    return null;
  }

  const parameters = Object.fromEntries(
    parametersPart.split(",").map((entry) => entry.split("=", 2)),
  );
  const cost = parsePositiveInteger(parameters.N);
  const blockSize = parsePositiveInteger(parameters.r);
  const parallelization = parsePositiveInteger(parameters.p);
  const keyLength = parsePositiveInteger(parameters.l);
  if (
    !cost ||
    !blockSize ||
    !parallelization ||
    !keyLength ||
    (cost & (cost - 1)) !== 0 ||
    cost > PASSWORD_COST ||
    blockSize > PASSWORD_BLOCK_SIZE ||
    parallelization > 4 ||
    keyLength > 64
  ) {
    return null;
  }

  try {
    const salt = Buffer.from(saltPart, "base64url");
    const expected = Buffer.from(hashPart, "base64url");
    if (salt.length < PASSWORD_SALT_LENGTH || salt.length > 64 || expected.length !== keyLength) {
      return null;
    }
    return { cost, blockSize, parallelization, keyLength, salt, expected };
  } catch {
    return null;
  }
};

/** Verify without throwing for invalid database values or hostile input. */
export const verifyPassword = async (password: string, encodedHash: string): Promise<boolean> => {
  if (!passwordByteLengthIsValid(password)) {
    return false;
  }
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) {
    return false;
  }
  try {
    const actual = await deriveScryptKey(
      password,
      parsed.salt,
      parsed.keyLength,
      parsed.cost,
      parsed.blockSize,
      parsed.parallelization,
    );
    return timingSafeEqual(actual, parsed.expected);
  } catch {
    return false;
  }
};

export const verifyPasswordOrDummy = (
  password: string,
  encodedHash?: string,
  verifier: (candidate: string, hash: string) => Promise<boolean> = verifyPassword,
): Promise<boolean> => verifier(password, encodedHash ?? DUMMY_PASSWORD_HASH);

/**
 * Verify every candidate without running memory-hard scrypt jobs concurrently.
 * A login may legitimately have the same email in many organizations, so the
 * caller must still check every hash before deciding whether a workspace slug
 * is required. Serial verification keeps one request's memory use bounded.
 */
export const verifyPasswordHashesSequentially = async (
  password: string,
  encodedHashes: readonly string[],
  verifier: (candidate: string, hash: string) => Promise<boolean> = verifyPassword,
): Promise<boolean[]> => {
  const matches: boolean[] = [];
  for (const encodedHash of encodedHashes) {
    matches.push(await verifier(password, encodedHash));
  }
  return matches;
};

export const passwordHashNeedsUpgrade = (encodedHash: string): boolean => {
  const parsed = parsePasswordHash(encodedHash);
  return (
    !parsed ||
    parsed.cost !== PASSWORD_COST ||
    parsed.blockSize !== PASSWORD_BLOCK_SIZE ||
    parsed.parallelization !== PASSWORD_PARALLELIZATION ||
    parsed.keyLength !== PASSWORD_KEY_LENGTH
  );
};

/** Return an unguessable URL/cookie-safe token. */
export const randomToken = (byteLength = TOKEN_BYTES): string => {
  if (!Number.isSafeInteger(byteLength) || byteLength < TOKEN_BYTES || byteLength > 256) {
    throw new RangeError(`Token entropy must be between ${TOKEN_BYTES} and 256 bytes`);
  }
  return randomBytes(byteLength).toString("base64url");
};

/**
 * Store only this digest, never the bearer token. A deployment pepper is optional
 * because every generated token already contains 256 bits of entropy.
 */
export const hashOpaqueToken = (token: string, pepper?: string): string => {
  if (!token) {
    throw new TypeError("Token must not be empty");
  }
  return pepper
    ? createHmac("sha256", pepper).update(token, "utf8").digest("hex")
    : createHash("sha256").update(token, "utf8").digest("hex");
};

export const verifyOpaqueToken = (
  token: string,
  expectedHash: string,
  pepper?: string,
): boolean => {
  if (!/^[a-f0-9]{64}$/i.test(expectedHash)) {
    return false;
  }
  const actual = Buffer.from(hashOpaqueToken(token, pepper), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const hashSessionToken = hashOpaqueToken;
export const hashCsrfToken = hashOpaqueToken;
export const hashUploadLinkToken = hashOpaqueToken;

export const createSessionTokens = (pepper?: string): SessionTokens => {
  const sessionToken = randomToken();
  const csrfToken = randomToken();
  return {
    sessionToken,
    sessionTokenHash: hashSessionToken(sessionToken, pepper),
    csrfToken,
    csrfTokenHash: hashCsrfToken(csrfToken, pepper),
  };
};

export const createUploadLinkToken = (pepper?: string): StoredToken => {
  const token = randomToken();
  return { token, tokenHash: hashUploadLinkToken(token, pepper) };
};

const PDF_MAGIC = Buffer.from("%PDF-", "ascii");

/** Require a genuine PDF file signature at byte zero; MIME names are not trusted. */
export const hasPdfMagicBytes = (input: Uint8Array): boolean => {
  if (input.byteLength < PDF_MAGIC.length) {
    return false;
  }
  const header = Buffer.from(input.buffer, input.byteOffset, PDF_MAGIC.length);
  return timingSafeEqual(header, PDF_MAGIC);
};

export const assertPdfMagicBytes = (input: Uint8Array): void => {
  if (!hasPdfMagicBytes(input)) {
    throw new TypeError("Uploaded file does not have a PDF signature");
  }
};

export const neutralizeCsvFormula = neutralizeCsvInjection;
export const neutralizeCsvCell = neutralizeCsvFormula;
