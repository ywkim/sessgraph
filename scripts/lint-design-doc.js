#!/usr/bin/env node

/**
 * Lint Design (TDD) documents for frontmatter integrity.
 * - Verify `related.prd` field exists
 * - Verify the linked PRD file actually exists
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const designDir = path.join(__dirname, "../docs/design");

if (!fs.existsSync(designDir)) {
  console.log("✓ No docs/design/ directory found. Skipping design doc check.");
  process.exit(0);
}

const designFiles = fs
  .readdirSync(designDir)
  .filter((f) => f.endsWith(".tdd.md"));
if (designFiles.length === 0) {
  console.log("✓ No design files found.");
  process.exit(0);
}

let hasErrors = false;

designFiles.forEach((file) => {
  const filePath = path.join(designDir, file);
  const content = fs.readFileSync(filePath, "utf-8");

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    console.error(`✗ ${file} - No YAML frontmatter found`);
    hasErrors = true;
    return;
  }

  try {
    const frontmatter = yaml.load(fmMatch[1]);

    if (!frontmatter.related || !frontmatter.related.prd) {
      console.error(`✗ ${file} - Missing 'related.prd' in frontmatter`);
      hasErrors = true;
      return;
    }

    const prdPath = path.join(__dirname, "..", frontmatter.related.prd);
    if (!fs.existsSync(prdPath)) {
      console.error(
        `✗ ${file} - Related PRD file not found: ${frontmatter.related.prd}`,
      );
      hasErrors = true;
    }
  } catch (err) {
    console.error(`✗ ${file} - Invalid YAML frontmatter: ${err.message}`);
    hasErrors = true;
  }
});

if (hasErrors) {
  console.error("\n❌ Design doc check failed.");
  process.exit(1);
}

console.log("✓ Design doc check passed.");
process.exit(0);
