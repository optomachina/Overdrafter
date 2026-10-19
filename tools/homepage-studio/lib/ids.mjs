// ULID-like ids: 10 chars of base32 millisecond time + 10 chars of randomness.
// Lowercase so every id satisfies /^[a-z0-9-]+$/ and sorts by creation time.
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function newId(now = Date.now(), bytes = randomBytes) {
  let t = Math.floor(now);
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = bytes(10);
  let rand = "";
  for (let i = 0; i < 10; i++) rand += ALPHABET[rnd[i] % 32];
  return time + rand;
}
