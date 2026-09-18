# pi-jev-approver

A shell command safety gate for the [Pi](https://pi.dev) coding agent, backed
by [TypeSafe](https://typesafe.ai)'s Jev judgment model instead of the chat
session model.

## Why not just use `pi-auto-approval`?

[`pi-auto-approval`](https://pi.dev/packages/pi-auto-approval) already does
AI-classifier-based approval for Pi, and is a good default. Its classifier is
the active chat session model (whatever you're talking to), which means every
approval check is a full LLM call: slow, and priced like a chat completion.

This extension swaps that layer for Jev, a small model purpose-trained for
structured judgments rather than text generation. In our own side-by-side
testing (see the [jev-test](../jev-test) project this was built alongside),
Jev classification ran in ~500ms vs ~2.5-3.5s for a comparable chat-model
call on the same task, at a fraction of the token cost, while returning
calibrated per-question confidence for free - which is what this extension
uses to decide when to trust an automatic decision versus asking a human.

## How it works

Every `bash` tool call gets sent to Jev with:

- the command itself
- current git branch, and whether it looks protected (`main`, `master`,
  `release/*`, `deploy/*`) - so `git push origin main` reads as riskier than
  the same push to a feature branch, without a separate rule for it
- the project's language ecosystem (detected from marker files: `package.json`,
  `pyproject.toml`/`setup.py`, `Cargo.toml`, `go.mod`, `Gemfile`, `pom.xml`/
  `build.gradle`) - installing dependencies runs arbitrary code during
  install/build in most of these (npm postinstall, Python `setup.py`, Rust
  `build.rs`), which Jev is told to weigh
- whether the command looks like a public package registry publish (`npm
  publish`, `twine upload`, `cargo publish`, `gem push`, `mvn deploy`, etc.)
  - a published version is visible to everyone who depends on it and is
    effectively permanent even if later deprecated, which "affects shared
    state" alone undersells
- whether any file-path-like argument resolves **outside the current
  project directory** (a sibling directory, the home directory, or the
  filesystem root) - this is what tells `rm -rf ../../other-project` apart
  from `rm -rf ./build`, which look identical to the `destructive` flag
  alone. Live-tested: the sibling-project case scored 1.99/2 at 0.99
  confidence with `why: operates_outside_project_directory`, versus 0.61 at
  low confidence for the scoped version of the same command.

Branch-protection, publish-command detection, and path-scope are all
deterministic lookups (regex/marker files/path resolution against `cwd`),
not semantic judgments - they're handed to Jev as state for it to weigh,
never asked as their own Noul question.

Jev returns a risk score (0-2) with confidence, five independent flags
(`destructive`, `hard_to_reverse`, `affects_shared_or_remote_state`,
`downloads_and_executes_code`, `modifies_permissions_or_ownership`), and a
`primary_concern` Choice - a typed "why" (Jev returns typed judgments, not
generated explanations, so this is its own question rather than a free-text
rationale) shown on the human prompt even when all five booleans read false
but the score is still elevated (e.g. a protected-branch target).

When a human is asked, the prompt also shows this exact command's decision
history (times seen, allowed/denied, last stated reason) if there is any -
informational only. That history is **not** fed into Jev's automated risk
score by default, since doing so risks a rubber-stamp loop: one approval
(careless or not) would quietly lower scrutiny for every future identical
command with no second check. Opt in with `PI_JEV_APPROVER_FEED_HISTORY=1`
if you've weighed that tradeoff; the safer default leaves learning from
aggregate history to the logistic regression below, which is accountable to
real statistics rather than a single ad hoc count.

```
confident + risk <= 0.5   -> auto-allow
confident + risk >= 1.5   -> auto-deny
dicey (or Jev itself is unsure) -> optionally escalate to a stronger LLM, else ask a human
```

Every decision is appended to a local, redacted JSONL audit log.

## Custom concerns

Add your own domain-specific flags without forking - each becomes a real,
independently-detectable Noul question, not just a label. Put them in
`~/.pi/pi-jev-approver/config.json` (see `config.example.json`):

```json
{
  "customConcerns": {
    "aws_command": "This command interacts with AWS infrastructure and could affect live cloud resources or incur cost"
  }
}
```

Custom concerns automatically flow into the `primary_concern` "why" choice
and the returned flags, same as the five built-in ones. Keys must be
lowercase snake_case; capped at 10 (each one adds a question to every
classification call, so more isn't free) and 300 characters of description.
Check what's currently configured with `/jev-approver config`.

## Optional: escalate to a stronger LLM before asking a human

For dicey commands, you can have the extension ask a real chat model for a
second opinion before bothering you - off by default. Enable it in
`config.json`:

```json
{
  "escalation": {
    "enabled": true,
    "model": "",
    "maxRiskScoreToEscalate": 1.5,
    "maxConfidenceToEscalate": 0.7
  }
}
```

`model` is a `provider/id` reference resolved through **Pi's own model
registry** (e.g. `"anthropic/claude-sonnet-5"`), or `""` to use whatever
model your Pi session is already talking to. Auth is whatever you already
have configured in Pi for that model - there's no separate API key to set
up here, unlike Jev (which needs its own `TYPESAFE_API_KEY` since it's a
different service entirely).

Escalation only fires when Jev's own risk score *and* confidence are both at
or below your thresholds. Unlike Jev, a real chat LLM can produce a written
rationale, which gets stored in the audit log (`llmEscalation.rationale`)
and shown in `/jev-approver recent`. If the LLM call fails, times out, or
doesn't return a clear allow/deny, this **always** falls through to asking
you - escalation can only reduce how often you're asked, it can never
replace you as the last resort. The system prompt also explicitly tells the
model that when it's unsure, denying (not allowing) is the safe default.

## Setup

```
pi install npm:pi-jev-approver   # once published
```

Set `TYPESAFE_API_KEY` in your environment (get one from
[typesafe.ai](https://typesafe.ai)). Without it, all bash calls fail closed.

Reload Pi and check status with `/jev-approver`.

## Privacy: redaction, not collection

Before a command is ever written to disk, `src/redact.ts` strips common
secret patterns (bearer tokens, `--password`/`--token` flags, long opaque
strings, emails, IPs, home-directory usernames). This is **best-effort, not
a guarantee** - free-form shell commands can leak secrets in ways no regex
set fully covers. Run `npx tsx scripts/test-redact.ts` to see the current
coverage.

There is no telemetry and nothing leaves your machine automatically. Run
`/jev-approver export` to copy a timestamped, redacted snapshot of your audit
log if you want to share or inspect it - review it yourself first.

## Training a lightweight classifier on top

Jev itself has no fine-tuning API - the only lever is how you write the
question, which is already tuned here. What *is* trainable is a small
classical model on top: every time a human is asked to approve a dicey
command, their answer is logged alongside Jev's risk score, confidence, and
flags. That's labeled data.

```
uv run --with scikit-learn,numpy scripts/train.py
```

Fits a logistic regression from Jev's outputs (+ git branch protection +
public-registry-publish detection, 9 features total) to the human's actual
decision. With enough real rows in your audit log, the learned weights tell
you which flags your team actually cares about - e.g. if
`downloads_and_executes_code` gets a near-zero weight, your team doesn't
treat that as a real signal in practice, whatever Jev's raw flag says. Below
~10x the feature count in real labeled rows (90 rows for the current 9
features) it falls back to a synthetic demo instead - fewer than that and
the fit is underdetermined enough to flip a coefficient's sign, which is
exactly what happened during development when this ran on 60 synthetic
rows with only 7 features.

This recalibrates the auto-allow/auto-deny thresholds to your team's actual
risk tolerance without touching Jev's weights at all.

## Known limitations

- No fine-tuning of Jev itself is possible; only the question text and the
  classical layer on top are tunable.
- Redaction is regex-based and best-effort - do not treat exported logs as
  safe to publish without a human reading them first.
- The `ask a human` path fails closed (denies) if Pi has no interactive UI
  available (e.g. non-interactive/CI runs) - there's no fallback approval
  channel implemented here.
- LLM escalation depends on `@oh-my-pi/pi-ai` or `@earendil-works/pi-ai`
  being resolvable (they ship with Pi itself) and on `ctx.modelRegistry`
  being present on the host - if either is missing, escalation reports
  "unsure" and falls through to asking you, it doesn't error out.
