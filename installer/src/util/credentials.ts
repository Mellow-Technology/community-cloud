/**
 * @file
 * Making up credentials nobody has to remember.
 *
 * Every application in the cluster needs a database password, and the
 * worst thing to do with that is ask a person for one. A password
 * chosen by hand is reused, written down, or turns out to be the same
 * one three clusters over. A password chosen here is used once, lives
 * in a Secret, and nobody ever has to type it.
 *
 * Words rather than characters, because the times these do get read
 * by a person — copied out of a Secret to debug a connection, read
 * down a telephone — are the times a string of punctuation goes
 * wrong. Five common words carry about as much guessing work as a
 * twelve character random string, and can be read aloud.
 *
 * The randomness is the part worth being careful about. random-words
 * picks with Math.random() unless it's given a seed, and Math.random()
 * is a fast generator rather than a safe one: it is seeded from
 * whatever the runtime had to hand, its state is recoverable from its
 * output, and it was never meant to choose anything anyone has an
 * interest in guessing. So every phrase here is drawn from a seed out
 * of node:crypto, which is.
 */
import { randomBytes } from "node:crypto";
import { generate } from "random-words";

// How many words each is made of. The username isn't a secret — it's
// half of a pair and it's in the Secret in plain text — so it's short
// enough to read. The password is the half that has to hold.
export const USERNAME_WORDS = 3;
export const PASSWORD_WORDS = 5;

// What goes between the words. A hyphen is safe everywhere these
// end up: a shell word, a YAML scalar, a Postgres password, a
// connection string.
export const WORD_SEPARATOR = "-";

// How many bytes of seed. More than the generator can possibly use,
// which costs nothing and means this doesn't have to be revisited if
// it ever starts using more.
const SEED_BYTES = 32;

/**
 * A seed with real randomness behind it.
 *
 * @returns
 */
function buildSeed(): string {
  return randomBytes(SEED_BYTES).toString("hex");
}

/**
 * A phrase of however many words, hyphen separated.
 *
 * The word list holds a little under two thousand words, so each one
 * is worth not quite eleven bits: three words is around thirty-three
 * and five is around fifty-five. The second of those is a real
 * password for something reachable only from inside the cluster. The
 * first is a name.
 *
 * @param words
 * @returns
 */
export function generatePhrase(words: number): string {
  return generate({ exactly: words, join: WORD_SEPARATOR, seed: buildSeed() });
}

/**
 * A username for something that doesn't care what it's called.
 *
 * Plenty of things do care — a Postgres role has to be called what
 * the thing connecting to it expects — so this is for the cases where
 * the name is ours to choose.
 *
 * @returns
 */
export function generateUsername(): string {
  return generatePhrase(USERNAME_WORDS);
}

/**
 * A password.
 *
 * @returns
 */
export function generatePassword(): string {
  return generatePhrase(PASSWORD_WORDS);
}
