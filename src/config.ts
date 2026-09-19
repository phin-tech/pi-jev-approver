// User-configurable extension concerns - domain-specific flags (e.g. "this
// touches AWS", "this touches a production Kubernetes context") that a
// team can add without forking. Each becomes a real Noul question, so it's
// independently detectable (not just a label) and flows automatically into
// the primary_concern "why" choice and the audit log/training data.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { compileRules, MAX_RULES, type CommandRule, type MatchedRule } from "./command-rules.js";

// Escalates to a real chat LLM when Jev's verdict falls in the dicey band
// by the user's own thresholds, via Pi's own model registry (ctx.model /
// ctx.modelRegistry) rather than a separately configured API key - reuses
// whatever the user already has set up in Pi (including Claude, if that's
// what they use). Off by default. If the LLM call fails, times out, or
// returns anything other than a clear allow/deny, this fails through to
// asking a human - escalation narrows how often a human is asked, it never
// replaces the human as the last resort.
export interface EscalationConfig {
  enabled: boolean;
  // Provider/id reference resolved through ctx.modelRegistry.find(), e.g.
  // "anthropic/claude-sonnet-5". Empty string means "use the active session
  // model" (ctx.model) - whatever the user is already talking to in Pi.
  model: string;
  // Escalate only when Jev's own verdict is in this band - both must hold.
  maxRiskScoreToEscalate: number;
  maxConfidenceToEscalate: number;
  timeoutSeconds: number;
}

export interface ExtensionConfig {
  customConcerns: Record<string, string>;
  escalation: EscalationConfig;
  // Compiled and ready to test - see command-rules.ts. Checked before
  // anything else in decision.ts: a match short-circuits the whole Jev/
  // human/escalation pipeline, in either direction.
  commandRules: MatchedRule[];
}

const DEFAULT_ESCALATION: EscalationConfig = {
  enabled: false,
  model: "",
  maxRiskScoreToEscalate: 1.5,
  maxConfidenceToEscalate: 0.7,
  timeoutSeconds: 20,
};

const EMPTY_CONFIG: ExtensionConfig = { customConcerns: {}, escalation: DEFAULT_ESCALATION, commandRules: [] };

// Keys become JSON field names sent to the API and object keys throughout
// the codebase - keep them predictable. Max count bounds token cost, since
// every custom concern adds one more question to every classification call.
const KEY_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;
const MAX_CUSTOM_CONCERNS = 10;
const MAX_DESCRIPTION_LENGTH = 300;

function parseCommandRules(raw: unknown): CommandRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: CommandRule[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.pattern !== "string" || r.pattern.length === 0) continue;
    if (r.action !== "allow" && r.action !== "deny") continue;
    rules.push({
      pattern: r.pattern,
      flags: typeof r.flags === "string" ? r.flags : undefined,
      action: r.action,
      weight: typeof r.weight === "number" ? r.weight : 0,
      reason: typeof r.reason === "string" ? r.reason.slice(0, 300) : undefined,
    });
  }
  return rules;
}

function parseEscalation(raw: unknown): EscalationConfig {
  if (typeof raw !== "object" || raw === null) return DEFAULT_ESCALATION;
  const r = raw as Record<string, unknown>;

  const enabled = r.enabled === true;
  const model = typeof r.model === "string" ? r.model : "";

  return {
    enabled,
    model,
    maxRiskScoreToEscalate:
      typeof r.maxRiskScoreToEscalate === "number"
        ? Math.min(2, Math.max(0, r.maxRiskScoreToEscalate))
        : DEFAULT_ESCALATION.maxRiskScoreToEscalate,
    maxConfidenceToEscalate:
      typeof r.maxConfidenceToEscalate === "number"
        ? Math.min(1, Math.max(0, r.maxConfidenceToEscalate))
        : DEFAULT_ESCALATION.maxConfidenceToEscalate,
    timeoutSeconds:
      typeof r.timeoutSeconds === "number" && r.timeoutSeconds > 0
        ? r.timeoutSeconds
        : DEFAULT_ESCALATION.timeoutSeconds,
  };
}

export function configPath(): string {
  return join(homedir(), ".pi", "pi-jev-approver", "config.json");
}

// path override exists only for tests - production callers always take the
// default (the real configPath()).
export async function loadConfig(path: string = configPath()): Promise<ExtensionConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return EMPTY_CONFIG; // no config file - fine, this is optional
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_CONFIG; // malformed config - fail open to defaults, not closed
  }

  const obj = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};

  const rawConcerns = obj.customConcerns;
  const customConcerns: Record<string, string> = {};
  if (typeof rawConcerns === "object" && rawConcerns !== null) {
    for (const [key, value] of Object.entries(rawConcerns as Record<string, unknown>)) {
      if (Object.keys(customConcerns).length >= MAX_CUSTOM_CONCERNS) break;
      if (!KEY_PATTERN.test(key)) continue;
      if (typeof value !== "string" || value.length === 0) continue;
      customConcerns[key] = value.slice(0, MAX_DESCRIPTION_LENGTH);
    }
  }

  return {
    customConcerns,
    escalation: parseEscalation(obj.escalation),
    commandRules: compileRules(parseCommandRules(obj.commandRules)),
  };
}

// Appends one rule to the on-disk config, used by the "Always allow" choice
// on the human prompt (decision.ts) so a one-time approval can turn into a
// standing rule without the user having to hand-edit config.json. Reads and
// rewrites the raw JSON (not the parsed ExtensionConfig) so any fields this
// extension doesn't know about are preserved untouched. Never touches
// existing rules beyond appending - a config mistake elsewhere is not this
// function's problem to fix.
export async function saveCommandRule(
  rule: CommandRule,
  path: string = configPath(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let raw: string | undefined;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    raw = undefined; // no config file yet - start from an empty object
  }

  let obj: Record<string, unknown> = {};
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) obj = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, reason: `${path} is not valid JSON - fix it by hand before adding a rule this way.` };
    }
  }

  const existingRules = Array.isArray(obj.commandRules) ? obj.commandRules : [];
  if (existingRules.length >= MAX_RULES) {
    return { ok: false, reason: `already at the ${MAX_RULES}-rule cap - remove one in config.json first.` };
  }

  obj.commandRules = [...existingRules, rule];

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
  return { ok: true };
}
