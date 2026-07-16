/**
 * PII GUARD — pseudonymize-and-rehydrate for text that leaves the machine.
 *
 * Detectable identifiers (emails, phone numbers, card numbers, SSNs) in
 * OUTGOING text are replaced with stable tokens like ⟨email-1⟩; the real
 * values live in this in-memory vault and never leave. When the cloud model
 * decides to USE one ("type ⟨email-1⟩ into the recipient field"), the
 * executor substitutes the real value locally at typing time — the cloud
 * reasons entirely over placeholders, yet the task completes correctly.
 *
 * Honest scope: this covers PATTERN-DETECTABLE identifiers in TEXT payloads.
 * Names rendered as ordinary page content, and anything visible in
 * screenshots, are not covered by this layer. Detection is deliberately
 * conservative — a missed phone number is a smaller failure than mangling
 * every price and order ID on a page (phones require separators or a leading
 * +; card numbers must pass Luhn).
 *
 * The vault is per-task: reset at run start. Tokens in a resumed run's
 * journal can no longer be rehydrated after a service-worker restart — the
 * values they masked are simply not typed back, never leaked.
 */

const vault = new Map<string, string>(); // token -> real value
const reverse = new Map<string, string>(); // real value -> token
const counters: Record<string, number> = {};

export function resetPiiVault(): void {
  vault.clear();
  reverse.clear();
  for (const key of Object.keys(counters)) delete counters[key];
}

function tokenFor(kind: string, value: string): string {
  const existing = reverse.get(value);
  if (existing) return existing;
  counters[kind] = (counters[kind] ?? 0) + 1;
  const token = `⟨${kind}-${counters[kind]}⟩`;
  vault.set(token, value);
  reverse.set(value, token);
  return token;
}

// Luhn checksum — the difference between a card number and any 16-digit ID
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 13-19 digits allowing space/dash separators, validated by Luhn
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
// US SSN shape
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// Phones: leading + (international), OR digit groups joined by separators
// (space/dash/parens), 8-15 digits total. Plain integers and decimals
// (prices, IDs, timestamps) deliberately do NOT match.
const PHONE_RE = /(?:\+\d{1,3}[\s-]?)?(?:\(\d{1,4}\)[\s-]?)?\d{2,4}(?:[\s-]\d{2,4}){2,4}\b|\+\d{8,15}\b/g;

/** Replace detectable identifiers with vault tokens. Idempotent. */
export function scrubPii(text: string): string {
  if (!text) return text;
  let out = text.replace(EMAIL_RE, match => tokenFor('email', match));
  out = out.replace(CARD_RE, match => {
    const digits = match.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return match;
    return tokenFor('card', match);
  });
  out = out.replace(SSN_RE, match => tokenFor('id', match));
  out = out.replace(PHONE_RE, match => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return match;
    return tokenFor('phone', match);
  });
  return out;
}

/** Substitute real values back into text about to be TYPED locally (or shown
 * to the user). No-op when the vault is empty or the text has no tokens. */
export function rehydratePii(text: string): string {
  if (!text || vault.size === 0 || !text.includes('⟨')) return text;
  let out = text;
  for (const [token, value] of vault) {
    if (out.includes(token)) out = out.split(token).join(value);
  }
  return out;
}

/** How many identifiers are currently masked (for trace/disclosure lines). */
export function piiVaultSize(): number {
  return vault.size;
}
