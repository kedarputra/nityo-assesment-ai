import { hash, verify } from "@node-rs/argon2";

// argon2id (security 1), the library's default algorithm, at OWASP's recommended minimum:
// 19 MiB of memory, two passes, one lane. The parameters travel inside each hash, so raising
// them later still verifies the old ones.
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}
