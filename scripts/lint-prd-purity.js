#!/usr/bin/env node

/**
 * Lint PRD (Product Requirements Document) for technical term purity.
 * PRD should only contain business goals and requirements, NOT technical terms.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TECH_TERMS = [
  "API",
  "endpoint",
  "REST",
  "GraphQL",
  "SQL",
  "JSONL",
  "JSON",
  "TypeScript",
  "JavaScript",
  "Node.js",
  "Python",
  "Rust",
  "Go",
  "DAG",
  "graph",
  "node",
  "edge",
  "parentUuid",
  "uuid",
  "compact_boundary",
  "cache",
  "index",
  "schema",
  "parser",
  "parse",
  "serialize",
  "CLI",
  "HTTP",
  "localhost",
  "byte offset",
  "stream",
  "framework",
  "library",
  "package",
  "dependency",
  "React",
  "virtual scroll",
  "frontend",
  "backend",
  "server",
  "client",
];

const TECH_PATTERN = new RegExp(`\\b(${TECH_TERMS.join("|")})\\b`, "gi");

const prdDir = path.join(__dirname, "../docs/prd");
if (!fs.existsSync(prdDir)) {
  console.log("✓ No docs/prd/ directory found. Skipping PRD purity check.");
  process.exit(0);
}

const prdFiles = fs.readdirSync(prdDir).filter((f) => f.endsWith(".prd.md"));
if (prdFiles.length === 0) {
  console.log("✓ No PRD files found.");
  process.exit(0);
}

let hasErrors = false;

prdFiles.forEach((file) => {
  const filePath = path.join(prdDir, file);
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  // Only check Why and What sections
  let inWhySection = false;
  let inWhatSection = false;

  lines.forEach((line, index) => {
    if (line.match(/^## Why\b/)) inWhySection = true;
    else if (
      line.match(/^## What\b/) ||
      line.match(/^## What\s*\/\s*Success Criteria/)
    ) {
      inWhySection = false;
      inWhatSection = true;
    } else if (line.match(/^##\s/)) {
      inWhySection = false;
      inWhatSection = false;
    }

    if ((inWhySection || inWhatSection) && line.match(TECH_PATTERN)) {
      console.error(`✗ ${file}:${index + 1} - Technical term found in PRD`);
      console.error(`  ${line.trim()}`);
      hasErrors = true;
    }
  });
});

if (hasErrors) {
  console.error(
    "\n❌ PRD purity check failed. Remove technical terms from Why/What sections.",
  );
  process.exit(1);
}

console.log("✓ PRD purity check passed.");
process.exit(0);
