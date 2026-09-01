#!/usr/bin/env node

/**
 * Check that ADR (Architecture Decision Record) files are append-only.
 * - Disallow modifications to Decision, Context, Alternatives Considered sections
 * - Allow only status field changes (Accepted → Superseded)
 * - Detect ADR number conflicts introduced by parallel work
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const adrDir = path.join(__dirname, "../docs/adr");

if (!fs.existsSync(adrDir)) {
  console.log(
    "✓ No docs/adr/ directory found. Skipping ADR immutability check.",
  );
  process.exit(0);
}

const adrFiles = fs.readdirSync(adrDir).filter((f) => f.endsWith(".md"));
if (adrFiles.length === 0) {
  console.log("✓ No ADR files found.");
  process.exit(0);
}

let hasErrors = false;

// `ADR-` prefix is optional so that files deviating from the naming convention
// are still detected for number conflicts rather than silently passing.
const ADR_NUMBER = /(?:ADR-)?(\d{3,4})/;

function getExistingAdrNumbers() {
  const existingNumbers = new Set();
  const baseRef = process.env.GITHUB_BASE_REF || "main";

  try {
    const lsTreeOutput = execSync(
      `git ls-tree -r --name-only origin/${baseRef} -- ${adrDir}`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] },
    );

    for (const file of lsTreeOutput.split("\n").filter((f) => f)) {
      const match = path.basename(file).match(ADR_NUMBER);
      if (match) {
        existingNumbers.add(parseInt(match[1], 10));
      }
    }
  } catch {
    // Base ref unavailable (shallow clone, first push) — treat as no history.
  }

  return existingNumbers;
}

try {
  const baseRef = process.env.GITHUB_BASE_REF;
  const diffCommand = baseRef
    ? `git diff origin/${baseRef}...HEAD -- ${adrDir}`
    : `git diff HEAD~1 HEAD -- ${adrDir}`;

  const diffOutput = execSync(diffCommand, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "ignore"],
  });

  if (!diffOutput) {
    console.log("✓ No changes to ADR files.");
    process.exit(0);
  }

  const existingAdrNumbers = getExistingAdrNumbers();

  const PROTECTED_SECTIONS = [
    "## Decision",
    "## Context",
    "## 후보 기술 & 각 선택지",
  ];

  const lines = diffOutput.split("\n");
  let currentFile = "";
  let inProtectedSection = false;
  let isNewFile = false;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/b\/(docs\/adr\/[\w.-]+\.md)/);
      if (match) currentFile = match[1];
      inProtectedSection = false;
      isNewFile = false;
    }

    if (line.startsWith("new file mode")) {
      isNewFile = true;

      const adrMatch = path.basename(currentFile).match(ADR_NUMBER);
      if (adrMatch && existingAdrNumbers.has(parseInt(adrMatch[1], 10))) {
        const adrNumber = adrMatch[1];
        console.error(
          `✗ ADR number conflict: ${adrNumber} already exists in ${baseRef || "main"}.`,
        );
        console.error(
          "\n  This is a distributed ID generation problem. When work happens in parallel,",
        );
        console.error(
          "  the same ADR number can be assigned independently. This PR introduces a duplicate.",
        );
        console.error("\n  To fix:");
        console.error(
          "  1. Rename this ADR to the next available number (usually +1 from the highest)",
        );
        console.error(
          "  2. If working locally, ensure your branch is up to date:",
        );
        console.error("     git fetch origin && git rebase origin/main");
        hasErrors = true;
      }
    }

    if (PROTECTED_SECTIONS.some((sec) => line.includes(sec))) {
      inProtectedSection = true;
    }

    if (
      inProtectedSection &&
      !isNewFile &&
      (line.startsWith("-") || line.startsWith("+"))
    ) {
      if (!line.includes("status:")) {
        console.error(
          `✗ ${currentFile} - Content modification detected in protected section`,
        );
        console.error(`  ${line}`);
        console.error("\n  ADR files are append-only. To change a decision:");
        console.error(
          "  1. Create a new ADR (docs/adr/ADR-{new-number}-{slug}.md)",
        );
        console.error(
          '  2. Update the old ADR status to "Superseded by ADR-{new-number}"',
        );
        hasErrors = true;
      }
    }
  }
} catch (err) {
  if (err.status === 128) {
    console.log("✓ Cannot check ADR history (no commits to compare).");
    process.exit(0);
  }
  console.error(`✗ Git error: ${err.message}`);
  hasErrors = true;
}

if (hasErrors) {
  console.error("\n❌ ADR immutability check failed.");
  process.exit(1);
}

console.log("✓ ADR immutability check passed.");
process.exit(0);
