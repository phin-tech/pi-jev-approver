// Best-effort redaction of secrets and identifying info from a shell command
// before it's ever written to disk or considered for export. This is a
// defense-in-depth layer, not a guarantee - free-form shell commands can
// embed secrets in ways no regex set fully covers. Treat redacted commands
// as "safer to share," never as "guaranteed safe to share."

const PATTERNS: Array<[RegExp, string]> = [
  // key=value / --flag value pairs whose name suggests a secret
  [/(\b(?:api[_-]?key|token|secret|password|passwd|pwd|auth|bearer)\b\s*[:=]\s*)([^\s"']+)/gi, "$1<redacted>"],
  [/(--?(?:password|token|secret|api-?key)\s+)([^\s"']+)/gi, "$1<redacted>"],
  // Bearer/Basic auth headers
  [/(Authorization:?\s*["']?(?:Bearer|Basic)\s+)([^\s"']+)/gi, "$1<redacted>"],
  // long opaque tokens (20+ alphanumeric/underscore/dash chars) - catches
  // most API keys, JWTs, hashes, even without a recognizable key= prefix
  [/\b[A-Za-z0-9_-]{20,}\b/g, "<redacted-token>"],
  // email addresses
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<redacted-email>"],
  // IPv4 addresses
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<redacted-ip>"],
  // home directory paths - keep structure, drop the username
  [/\/(Users|home)\/[^/\s]+/g, "/$1/<redacted-user>"],
];

export function redactCommand(command: string): string {
  let result = command;
  for (const [pattern, replacement] of PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
