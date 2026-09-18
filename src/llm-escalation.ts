// Escalates a dicey command to a stronger chat LLM when Jev itself is
// uncertain, via Pi's own model registry - the same path pi-auto-approval
// uses for its classifier. This means auth is whatever the user already has
// configured in Pi for that model (including Claude, if that's their
// active model or a registered provider); no separate API key config here.
//
// Unlike Jev, a chat LLM CAN produce a free-text rationale, so this is
// where that comes from.
//
// Fails safe on every error path: a missing model, a network failure, a
// timeout, or a response that doesn't parse into a clear allow/deny all
// return { decision: "unsure" }, which the caller must treat as "ask a
// human" - this function must never become an accidental auto-allow from a
// parse bug or a missing package.

import type { EscalationConfig } from "./config.js";
import type { JevVerdict } from "./jev-client.js";
import type { GitContext } from "./git-context.js";
import type { ProjectContext } from "./project-context.js";
import type { ExtensionContextLike } from "./types.js";

export interface EscalationVerdict {
  decision: "allow" | "deny" | "unsure";
  rationale: string;
  modelUsed?: string;
}

const SYSTEM_PROMPT = `You are a second-opinion safety reviewer for a shell command an autonomous \
coding agent wants to run. A smaller, faster model already produced a risk assessment but was not \
confident enough to trust automatically. Decide whether to allow or deny running this command \
without further human confirmation.

Respond with ONLY this JSON, no other text:
{"decision": "allow" | "deny", "rationale": "one or two sentences, specific to this command"}

If you are not confident either way, respond with {"decision": "deny", "rationale": "..."} - when \
genuinely unsure, denying (and letting a human decide) is always the safe choice, never allow.`;

function buildUserPrompt(command: string, jev: JevVerdict, git?: GitContext, project?: ProjectContext): string {
  const lines = [
    `Command: ${command}`,
    `First-pass model verdict: risk=${jev.riskScore.toFixed(2)}/2, confidence=${jev.confidence.toFixed(2)}, primary concern: ${jev.primaryConcern}`,
    `Flags raised: ${Object.entries(jev.flags).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}`,
  ];
  if (git?.isGitRepo) {
    lines.push(`Git branch: ${git.branch}${git.isProtectedBranch ? " (protected)" : ""}`);
  }
  if (project) {
    lines.push(`Project ecosystem: ${project.ecosystem}`);
  }
  return lines.join("\n");
}

type CompleteSimple = (model: unknown, context: unknown, options: Record<string, unknown>) => Promise<unknown>;

async function loadCompleteSimple(): Promise<CompleteSimple> {
  for (const pkg of ["@oh-my-pi/pi-ai", "@earendil-works/pi-ai"]) {
    try {
      const mod = await import(pkg);
      if (typeof mod.completeSimple === "function") {
        return mod.completeSimple as CompleteSimple;
      }
    } catch {
      // try the next package scope
    }
  }
  throw new Error("could not load completeSimple from @oh-my-pi/pi-ai or @earendil-works/pi-ai");
}

function resolveModel(ctx: ExtensionContextLike, modelRef: string): unknown {
  if (!modelRef) {
    return ctx.model; // "" means: use whatever model the session is already using
  }
  const slash = modelRef.indexOf("/");
  if (slash <= 0) {
    return { ...(ctx.model as Record<string, unknown> | undefined), id: modelRef };
  }
  const provider = modelRef.slice(0, slash);
  const id = modelRef.slice(slash + 1);
  const found = ctx.modelRegistry?.find?.(provider, id);
  return found ?? { ...(ctx.model as Record<string, unknown> | undefined), provider, id };
}

function extractAssistantText(response: unknown): string | undefined {
  const record = response as Record<string, unknown> | undefined;
  const content = record?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => (typeof item?.text === "string" ? item.text : "")).join("");
  }
  return undefined;
}

export async function escalateToLLM(
  ctx: ExtensionContextLike,
  command: string,
  jev: JevVerdict,
  config: EscalationConfig,
  git?: GitContext,
  project?: ProjectContext,
): Promise<EscalationVerdict> {
  const model = resolveModel(ctx, config.model);
  if (!model) {
    return { decision: "unsure", rationale: "no model available to escalate to (no active session model, and none configured)" };
  }

  let completeSimple: CompleteSimple;
  try {
    completeSimple = await loadCompleteSimple();
  } catch (error) {
    return { decision: "unsure", rationale: String(error) };
  }

  let auth: Record<string, unknown> = {};
  try {
    const resolved = await ctx.modelRegistry?.getApiKeyAndHeaders?.(model);
    if (resolved && resolved.ok) {
      auth = { apiKey: resolved.apiKey, headers: resolved.headers, env: resolved.env };
    }
  } catch {
    // fall through with no extra auth - completeSimple may still resolve it
    // itself for the active session model
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000);
  try {
    const response = await completeSimple(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(command, jev, git, project), timestamp: Date.now() }],
      },
      { temperature: 0, ...auth, signal: controller.signal },
    );

    const text = extractAssistantText(response)?.trim();
    if (!text) {
      return { decision: "unsure", rationale: "escalation model returned no text" };
    }

    let jsonText = text;
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
    }
    const parsed = JSON.parse(jsonText);
    if (parsed.decision === "allow" || parsed.decision === "deny") {
      return {
        decision: parsed.decision,
        rationale: typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 500) : "",
        modelUsed: (model as Record<string, unknown>)?.id as string | undefined,
      };
    }
    return { decision: "unsure", rationale: "escalation response had no valid decision field" };
  } catch (error) {
    return { decision: "unsure", rationale: `escalation call failed: ${String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}
