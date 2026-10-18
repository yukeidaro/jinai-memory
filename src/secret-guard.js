const PATTERNS = [
  ["api_key", /\bsk-[A-Za-z0-9_-]{17,}/u],
  ["aws_access_key", /\bAKIA[A-Z0-9]{16}\b/u],
  ["github_token", /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/u],
  ["private_key", /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/u],
  ["password", /(?:\b(?:password|passwd)\b|パスワード|暗証番号)["']?[ \t]*[:=：][ \t]*["']?[^\s"'`]+/iu],
];

function passesLuhn(digits) {
  let sum = 0;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if ((digits.length - 1 - index) % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function findSecret(text) {
  if (typeof text !== "string") throw new TypeError("text must be a string");
  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(text)) return { kind };
  }
  for (const [candidate] of text.matchAll(/\d(?:[ \t-]*\d)*/gu)) {
    const digits = candidate.replace(/[ \t-]/gu, "");
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) {
      return { kind: "card_number" };
    }
  }
  return null;
}
