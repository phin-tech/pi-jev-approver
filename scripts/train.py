"""
Fit a lightweight logistic regression on top of Jev's judgments, using real
human approve/deny decisions from pi-jev-approver's audit log as labels.

This recalibrates the auto-allow/auto-deny thresholds to your team's actual
risk tolerance, without touching Jev itself (there's no fine-tuning API -
this is the customization lever that exists instead).

Usage:
  uv run --with scikit-learn,numpy scripts/train.py [path/to/audit.jsonl]

If no path is given, defaults to ~/.pi/pi-jev-approver/audit.jsonl. If that
file doesn't exist or has too few human-labeled rows, falls back to a small
synthetic dataset so you can see the mechanic work end to end.
"""

import json
import os
import sys

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split

FLAG_KEYS = [
    "destructive",
    "hard_to_reverse",
    "affects_shared_or_remote_state",
    "downloads_and_executes_code",
    "modifies_permissions_or_ownership",
]
FEATURE_NAMES = (
    ["risk_score", "confidence"]
    + FLAG_KEYS
    + ["git_branch_is_protected", "looks_like_public_registry_publish"]
)


def load_real_rows(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if row.get("route") in ("human_allow", "human_deny"):
                rows.append(row)
    return rows


def synthetic_rows(n: int = 400, seed: int = 0) -> list[dict]:
    """Stand-in data: humans here mostly follow risk score, are more
    tolerant of 'downloads_and_executes_code' (e.g. trusted CI installers)
    than the raw score alone would suggest, are noticeably harsher when the
    target branch is protected (main/master/release), and are almost never
    willing to auto-approve a public package registry publish - four
    deliberately learnable patterns so training visibly recovers each."""
    rng = np.random.default_rng(seed)
    rows = []
    for _ in range(n):
        risk = float(rng.uniform(0, 2))
        confidence = float(rng.uniform(0.4, 1.0))
        flags = {k: bool(rng.random() < 0.3) for k in FLAG_KEYS}
        is_protected = bool(rng.random() < 0.3)
        is_publish = bool(rng.random() < 0.15)

        approve_logit = -3.0 * (risk - 1.0)
        approve_logit += 2.0 if flags["downloads_and_executes_code"] else 0.0
        approve_logit -= 3.0 if flags["destructive"] else 0.0
        approve_logit -= 2.5 if is_protected else 0.0
        approve_logit -= 4.0 if is_publish else 0.0
        p_approve = 1 / (1 + np.exp(-approve_logit))
        approved = bool(rng.random() < p_approve)

        rows.append(
            {
                "jev": {"riskScore": risk, "confidence": confidence, "flags": flags},
                "git": {"isProtectedBranch": is_protected},
                "project": {"looksLikePublishCommand": is_publish},
                "humanApproved": approved,
            }
        )
    return rows


def to_xy(rows: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    X, y = [], []
    for row in rows:
        jev = row["jev"]
        git = row.get("git") or {}
        project = row.get("project") or {}
        features = (
            [jev["riskScore"], jev["confidence"]]
            + [1.0 if jev["flags"].get(k) else 0.0 for k in FLAG_KEYS]
            + [1.0 if git.get("isProtectedBranch") else 0.0]
            + [1.0 if project.get("looksLikePublishCommand") else 0.0]
        )
        X.append(features)
        y.append(1 if row["humanApproved"] else 0)
    return np.array(X), np.array(y)


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
        "~/.pi/pi-jev-approver/audit.jsonl"
    )
    rows = load_real_rows(path)
    # Rule of thumb: want ~10x more rows than features (10 features here) to
    # get stable coefficients rather than an overfit, noisy fit - see the
    # 60-row vs 400-row synthetic runs during development, where 60 rows
    # flipped the sign on one coefficient relative to the injected pattern.
    min_rows = len(FEATURE_NAMES) * 10
    using_synthetic = len(rows) < min_rows
    if using_synthetic:
        print(
            f"Only {len(rows)} human-labeled rows found at {path} "
            f"(want {min_rows}+ for {len(FEATURE_NAMES)} features) - using "
            "synthetic demo data instead.\n"
        )
        rows = synthetic_rows()
    else:
        print(f"Training on {len(rows)} real human-labeled rows from {path}\n")

    X, y = to_xy(rows)
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.25, random_state=0
    )

    model = LogisticRegression()
    model.fit(X_train, y_train)
    accuracy = model.score(X_test, y_test)

    print(f"Held-out accuracy: {accuracy:.2f} ({len(X_test)} test rows)\n")
    print("Learned weights (positive = pushes toward approval):")
    print(f"  {'intercept':<35} {model.intercept_[0]:+.3f}")
    for name, coef in zip(FEATURE_NAMES, model.coef_[0]):
        print(f"  {name:<35} {coef:+.3f}")

    if using_synthetic:
        print(
            "\nNote: this is synthetic data with deliberately injected "
            "patterns (tolerant of downloads_and_executes_code, harsh on "
            "destructive, protected-branch targets, and public registry "
            "publishes) - the point is to show the weights recover those "
            "patterns, not to represent anyone's real preferences."
        )


if __name__ == "__main__":
    main()
