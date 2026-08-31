import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "enc:v1";
const IV_BYTES = 12;

const encryptionKey = (keyMaterial: string): Buffer => {
  if (Buffer.byteLength(keyMaterial, "utf8") < 32) {
    throw new RangeError("Secret encryption key material must be at least 32 UTF-8 bytes");
  }
  return createHash("sha256")
    .update("OpenCOI integration secret encryption v1\0", "utf8")
    .update(keyMaterial, "utf8")
    .digest();
};

/** Encrypt an integration secret using authenticated AES-256-GCM and contextual AAD. */
export const encryptSecret = (plaintext: string, keyMaterial: string, context: string): string => {
  if (!plaintext || !context) throw new TypeError("Secret and encryption context are required");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(keyMaterial), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
};

/** Decrypt only when both the deployment key and record-bound context match. */
export const decryptSecret = (encoded: string, keyMaterial: string, context: string): string => {
  const [prefix, version, ivValue, tagValue, encryptedValue, extra] = encoded.split(":");
  if (`${prefix}:${version}` !== VERSION || !ivValue || !tagValue || !encryptedValue || extra) {
    throw new TypeError("Encrypted secret has an unsupported format");
  }
  const iv = Buffer.from(ivValue, "base64url");
  const tag = Buffer.from(tagValue, "base64url");
  const encrypted = Buffer.from(encryptedValue, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== 16 || encrypted.length === 0) {
    throw new TypeError("Encrypted secret is malformed");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(keyMaterial), iv);
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
};
