import type { ExtensionContextLike, ToolCallDecision, ToolCallEventLike } from "./types.js";
import { classifyCommand, type JevVerdict } from "./jev-client.js";
import { writeAuditRow } from "./audit-log.js";
import { redactCommand } from "./redact.js";
import { getGitContext, type GitContext } from "./git-context.js";
import { getProjectContext, type ProjectContext } from "./project-context.js";

// Auto-allow below this risk score, given high confidence.
const AUTO_ALLOW_MAX_RISK = 0.5;
// Auto-deny at or above this risk score, given high confidence.
const AUTO_DENY_MIN_RISK = 1.5;
// Below this confidence, never trust the risk score either way - ask.
const MIN_CONFIDENT = 0.7;

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

async function askHuman(
  ctx: ExtensionContextLike,
  command: string,
  jev: JevVerdict,
  git: GitContext,
  project: ProjectContext,
): Promise<boolean> {
  if (!ctx.hasUI || !ctx.ui?.select) {
    return false; // fail closed - no UI to ask through
  }
  const branchLine = git.isGitRepo
    ? `  branch: ${git.branch}${git.isProtectedBranch ? " (protected)" : ""}\n`
    : "";
  const publishLine = project.looksLikePublishCommand
    ? `  looks like a ${project.ecosystem} package publish command\n`
    : "";
  const message =
    `pi-jev-approver: uncertain about this command.\n` +
    `  command: ${command}\n` +
    branchLine +
    publishLine +
    `  risk=${jev.riskScore.toFixed(2)}/2  confidence=${jev.confidence.toFixed(2)}\n` +
    `  flags: ${flagSummary(jev)}`;
  const choice = await ctx.ui.select(message, ["Allow", "Deny"]);
  return choice === "Allow";
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
  const [git, project] = await Promise.all([getGitContext(cwd), getProjectContext(cwd, command)]);

  let jev: JevVerdict;
  try {
    jev = await classifyCommand(command, apiKey, git, project);
  } catch (error) {
    ctx.ui?.notify?.(`pi-jev-approver: classification failed (${String(error)}), failing closed.`, "warning");
    await writeAuditRow({
      timestamp: new Date().toISOString(),
      command: redactCommand(command),
      jev: { riskScore: -1, confidence: 0, flags: {}, flagProbabilities: {} },
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
      reason: `pi-jev-approver: blocked as high-risk (score ${jev.riskScore.toFixed(2)}/2, flags: ${flagSummary(jev)}). Ask the user directly if this needs to run.`,
    };
  }

  // Dicey: mid-range risk, or the model itself isn't confident. Ask a human,
  // and log their answer against Jev's features - this pairing is the
  // training signal for a future classical model on top of these features.
  const approved = await askHuman(ctx, command, jev, git, project);
  await writeAuditRow({
    timestamp: new Date().toISOString(),
    command: logged,
    jev,
    git,
    project,
    route: approved ? "human_allow" : "human_deny",
    humanApproved: approved,
  });

  return approved ? {} : { block: true, reason: "User denied this command when asked." };
}
