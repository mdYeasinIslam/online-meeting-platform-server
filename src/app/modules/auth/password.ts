import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
const OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, OPTIONS, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return `scrypt-v1:${salt.toString("hex")}:${hash.toString("hex")}`;
}
export async function verifyPassword(password: string, stored?: string): Promise<boolean> {
  const [version, saltHex, hashHex] = (stored ?? "").split(":");
  const valid = version === "scrypt-v1" && /^[a-f0-9]{32}$/.test(saltHex ?? "") && /^[a-f0-9]{128}$/.test(hashHex ?? "");
  // Perform the same expensive derivation for missing/Google-only users.
  const hash = await derive(password, valid ? Buffer.from(saltHex, "hex") : Buffer.alloc(16));
  return valid && timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
}
