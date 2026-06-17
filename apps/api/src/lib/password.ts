/**
 * Password hashing via Bun's built-in argon2id (no native dependency needed).
 */
export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: "argon2id" });
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return Bun.password.verify(plain, hash);
}
