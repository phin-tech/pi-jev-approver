import type { ExtensionContextLike, ToolCallDecision, ToolCallEventLike } from "./types.js";
import { classifyCommand, type JevVerdict } from "./jev-client.js";
import { writeAuditRow, getPriorDecisions, type PriorDecisions } from "./audit-log.js";
import { redactCommand } from "./redact.js";
import { getGitContext, type GitContext } from "./git-context.js";
import { getProjectContext, type ProjectContext } from "./project-context.js";
import { loadConfig } from "./config.js";
import { escalateToLLM } from "./llm-escalation.js";

// Auto-allow below this risk score, given high confidence.
const AUTO_ALLOW_MAX_RISK = 0.5;
// Auto-deny at or above this risk score, given high confidence.
const AUTO_DENY_MIN_RISK = 1.5;
// Below this confidence, never trust the risk score either way - ask.
const MIN_CONFIDENT = 0.7;

// Off by default: feeding prior human decisions into Jev's automated risk
// score can create a rubber-stamp loop, where one approval (careless or
// not) quietly lowers scrutiny for every future identical command without
// a second independent check. The safer default is to still show history
// to a human when asked (informational, no automation risk) and leave
// learning from aggregate history to scripts/train.py's regression, which
// is accountable to real statistics rather than a single ad hoc count.
// Opt in with PI_JEV_APPROVER_FEED_HISTORY=1 if you've weighed that tradeoff.
const FEED_PRIOR_DECISIONS_INTO_RISK_SCORE = process.env.PI_JEV_APPROVER_FEED_HISTORY === "1";

function getCommand(event: ToolCallEventLike): string | undefined {
  const toolName = (event.toolName ?? event.name) as string | undefined;
  if (toolName !== "bash") return undefined;
  const input = (event.input ?? event.arguments) as Record<string, unknown> | undefined;
  const command = input?.command;
  return typeof command === "string" ? command : undefined;
}

function flagSummary(jev: JevVerdict): string {
  const active = Object.entries(jev.flags)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return active.length ? active.join(", ") : "none";
}

interface HumanDecision {
  approved: boolean;
  reason?: string;
}

async function askHuman(
  ctx: ExtensionContextLike,
  command: string,
  jev: JevVerdict,
  git: GitContext,
  project: ProjectContext,
  priorDecisions: PriorDecisions,
): Promise<HumanDecision> {
  if (!ctx.hasUI || !ctx.ui?.select) {
    return { approved: false }; // fail closed - no UI to ask through
  }
  const branchLine = git.isGitRepo
    ? `  branch: ${git.branch}${git.isProtectedBranch ? " (protected)" : ""}\n`
    : "";
  const publishLine = project.looksLikePublishCommand
    ? `  looks like a ${project.ecosystem} package publish command\n`
    : "";
  // Shown to the human regardless of FEED_PRIOR_DECISIONS_INTO_RISK_SCORE -
  // informing a human's own judgment carries none of the automated
  // rubber-stamp risk that feeding it into Jev's score would.
  const historyLine =
    priorDecisions.timesSeen > 0
      ? `  history: this exact command seen ${priorDecisions.timesSeen}x before ` +
        `(${priorDecisions.humanAllowed} allowed, ${priorDecisions.humanDenied} denied)` +
        (priorDecisions.lastReason ? `, last reason: "${priorDecisions.lastReason}"` : "") +
        "\n"
      : "";
  const message =
    `pi-jev-approver: uncertain about this command.\n` +
    `  command: ${command}\n` +
    branchLine +
    publishLine +
    historyLine +
    `  risk=${jev.riskScore.toFixed(2)}/2  confidence=${jev.confidence.toFixed(2)}\n` +
    `  flags: ${flagSummary(jev)}\n` +
    `  why: ${jev.primaryConcern.replace(/_/g, " ")}`;
  const choice = await ctx.ui.select(message, ["Allow", "Deny"]);
  const approved = choice === "Allow";

  // Optional - captures *why*, which a bare allow/deny throws away and which
  // is exactly the signal that makes the audit log worth training on later,
  // not just tallying. Skippable: empty input just means no reason given.
  let reason: string | undefined;
  if (ctx.ui.input) {
    const entered = await ctx.ui.input(
      `Reason for ${approved ? "allowing" : "denying"} this (optional, Enter to skip):`,
    );
    reason = entered?.trim() || undefined;
  }

  return { approved, reason };
}

export async function evaluateToolCall(
  event: ToolCallEventLike,
  ctx: ExtensionContextLike,
  apiKey: string,
): Promise<ToolCallDecision> {
  const command = getCommand(event);
  if (!command) {
    return {}; // not a bash call - not this extension's concern
  }

  const cwd = ctx.cwd || process.cwd();
  const [git, project, priorDecisions, config] = await Promise.all([
    getGitContext(cwd),
    getProjectContext(cwd, command),
    getPriorDecisions(redactCommand(command)),
    loadConfig(),
  ]);

  let jev: JevVerdict;
  try {
    jev = await classifyCommand(
      command,
      apiKey,
      git,
      project,
      FEED_PRIOR_DECISIONS_INTO_RISK_SCORE ? priorDecisions : undefined,
      config.customConcerns,
    );
  } catch (error) {
    ctx.ui?.notify?.(`pi-jev-approver: classification failed (${String(error)}), failing closed.`, "warning");
    await writeAuditRow({
      timestamp: new Date().toISOString(),
      command: redactCommand(command),
      jev: { riskScore: -1, confidence: 0, flags: {}, flagProbabilities: {}, primaryConcern: "classification_failed" },
      git,
      project,
      route: "failed_closed",
    });
    return { block: true, reason: "pi-jev-approver could not classify this command and failed closed." };
  }

  const confident = jev.confidence >= MIN_CONFIDENT;

  const logged = redactCommand(command);

  if (confident && jev.riskScore <= AUTO_ALLOW_MAX_RISK) {
    await writeAuditRow({
      timestamp: new Date().toISOString(),
      command: logged,
      jev,
      git,
      project,
      route: "auto_allow",
    });
    return {};
  }

  if (confident && jev.riskScore >= AUTO_DENY_MIN_RISK) {
    await writeAuditRow({
      timestamp: new Date().toISOString(),
      command: logged,
      jev,
      git,
      project,
      route: "auto_deny",
    });
    return {
      block: true,
      reason: `pi-jev-approver: blocked as high-risk (score ${jev.riskScore.toFixed(2)}/2, why: ${jev.primaryConcern.replace(/_/g, " ")}, flags: ${flagSummary(jev)}). Ask the user directly if this needs to run.`,
    };
  }

  // Dicey: mid-range risk, or the model itself isn't confident. Optionally
  // escalate to a stronger chat LLM before asking a human (see config.ts's
  // escalation section) - the LLM can only resolve this on its own if it
  // returns a clear allow/deny; "unsure" or any failure falls through to
  // asking a human exactly as if escalation were off.
  const shouldEscalate =
    config.escalation.enabled &&
    jev.riskScore <= config.escalation.maxRiskScoreToEscalate &&
    jev.confidence <= config.escalation.maxConfidenceToEscalate;

  if (shouldEscalate) {
    const verdict = await escalateToLLM(ctx, command, jev, config.escalation, git, project);
    if (verdict.decision !== "unsure") {
      const approved = verdict.decision === "allow";
      await writeAuditRow({
        timestamp: new Date().toISOString(),
        command: logged,
        jev,
        git,
        project,
        route: approved ? "llm_allow" : "llm_deny",
        llmEscalation: verdict,
      });
      return approved
        ? {}
        : {
            block: true,
            reason: `pi-jev-approver: denied by escalation model (${verdict.modelUsed ?? "unknown model"}): ${verdict.rationale}`,
          };
    }
    // "unsure" (including any escalation failure) - fall through to asking
    // a human, same as if escalation were disabled for this call.
  }

  // Ask a human, and log their answer against Jev's features - this pairing
  // is the training signal for a future classical model on top of these
  // features.
  const { approved, reason: humanReason } = await askHuman(ctx, command, jev, git, project, priorDecisions);
  await writeAuditRow({
    timestamp: new Date().toISOString(),
    command: logged,
    jev,
    git,
    project,
    route: approved ? "human_allow" : "human_deny",
    humanApproved: approved,
    humanReason,
  });

  return approved
    ? {}
    : { block: true, reason: humanReason ? `User denied: ${humanReason}` : "User denied this command when asked." };
}
