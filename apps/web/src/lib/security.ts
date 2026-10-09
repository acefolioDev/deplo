import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { cookies, headers } from "next/headers";
import { prisma } from "./db";

const scrypt = promisify(scryptCallback);
export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
export const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${hash.toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [, salt, expected] = encoded.split(":");
  if (!salt || !expected) return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  return safeEqual(actual.toString("hex"), expected);
}
export function encryptionKey() {
  const key = Buffer.from(process.env.ENCRYPTION_KEY ?? "", "base64");
  if (key.length !== 32)
    throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  return key;
}
export function encrypt(value: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString("base64");
}
export function decrypt(value: string) {
  const data = Buffer.from(value, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    data.subarray(0, 12),
  );
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([
    decipher.update(data.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}
export async function currentUser() {
  const token = (await cookies()).get("deplo_session")?.value;
  if (!token) return null;
  const session = await prisma.sessions.findFirst({
    where: { token_hash: sha256(token), expires_at: { gt: new Date() } },
    select: { users: { select: { id: true, email: true } } },
  });
  return session?.users ?? null;
}
export async function agentIdentity(request: Request) {
  const bearer = request.headers
    .get("authorization")
    ?.match(/^Bearer ([A-Za-z0-9_-]{30,})$/)?.[1];
  if (!bearer) return null;
  return prisma.agent_credentials.findFirst({
    where: {
      token_hash: sha256(bearer),
      revoked_at: null,
      OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
    },
    select: { id: true, server_id: true, pending: true },
  });
}
export async function validOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = process.env.PUBLIC_URL;
  if (!expected || !origin) return false;
  const host = (await headers()).get("host");
  if (!host) return false;
  if (origin === new URL(expected).origin && new URL(expected).host === host)
    return true;
  if (process.env.DEPLO_LOCAL_DEMO !== "1") return false;
  const allowed = new Set(["localhost:3456", "127.0.0.1:3456"]);
  try {
    const submitted = new URL(origin);
    return (
      submitted.protocol === "http:" &&
      allowed.has(submitted.host) &&
      allowed.has(host)
    );
  } catch {
    return false;
  }
}
export function cookieSettings() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure:
      new URL(process.env.PUBLIC_URL ?? "http://localhost:3000").protocol ===
      "https:",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  };
}
