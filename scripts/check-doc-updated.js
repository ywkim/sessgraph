#!/usr/bin/env node

/**
 * Check that a changed PRD/Design/Spec document has a current `updated:` value.
 * docs/README.md: PRD/Design/Spec are edited in place and `updated:` is bumped.
 * The value must not be earlier than the author date of the newest change to
 * the file in the PR (or the last commit), so several edits on one day pass.
 * Merge commits are ignored (a PR check runs on GitHub's merge commit), and
 * the log range excludes commits that only exist on the base branch.
 * A push to the base branch is skipped in CI: GitHub's squash commit carries
 * the merge time as its author date, so it says nothing about when the
 * document was edited; the PR check already covered that change.
 * Newly added documents are skipped.
 */

import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

const DOC_DIRS = ["docs/prd", "docs/design", "docs/spec"];
const baseRef = process.env.GITHUB_BASE_REF;
if (!baseRef && process.env.GITHUB_ACTIONS === "true") {
  console.log(
    "✓ Push build. The pull request check already covered this change.",
  );
  process.exit(0);
}
const diffRange = baseRef ? `origin/${baseRef}...HEAD` : "HEAD~1..HEAD";
const logRange = baseRef ? `origin/${baseRef}..HEAD` : "HEAD~1..HEAD";

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "ignore"],
  });
}

function updatedOf(text) {
  const match = text.match(/^updated:\s*(\S+)\s*$/m);
  return match ? match[1] : null;
}

let changed;
try {
  changed = git([
    "diff",
    "--name-status",
    "--diff-filter=M",
    diffRange,
    "--",
    ...DOC_DIRS,
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1])
    .filter((file) => file.endsWith(".md"));
} catch {
  console.log("✓ Base ref unavailable. Skipping updated: check.");
  process.exit(0);
}

const stale = [];
let checked = 0;
for (const file of changed) {
  let committed;
  try {
    committed = git([
      "log",
      "-1",
      "--no-merges",
      "--format=%as",
      logRange,
      "--",
      file,
    ]).trim();
  } catch {
    continue;
  }
  const updated = updatedOf(git(["show", `HEAD:${file}`]));
  if (committed && updated !== null) checked += 1;
  if (committed && updated !== null && updated < committed) {
    stale.push({ file, updated, committed });
  }
}

if (stale.length > 0) {
  for (const { file, updated, committed } of stale) {
    console.error(
      `✗ ${file}: updated: ${updated} is before the change (${committed})`,
    );
  }
  console.error("Bump `updated:` in changed PRD/Design/Spec (docs/README.md).");
  process.exit(1);
}
console.log(`✓ updated: is current in all ${checked} changed docs.`);
