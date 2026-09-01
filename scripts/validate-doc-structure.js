#!/usr/bin/env node

/**
 * Validate document structure against templates.
 * Usage: node scripts/validate-doc-structure.js --type=prd|design|spec
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const typeArg = args.find((arg) => arg.startsWith("--type="));
if (!typeArg) {
  console.error(
    "Usage: node scripts/validate-doc-structure.js --type=prd|design|spec",
  );
  process.exit(1);
}

const docType = typeArg.replace("--type=", "");
const validTypes = ["prd", "design", "spec"];

if (!validTypes.includes(docType)) {
  console.error(
    `Invalid type: ${docType}. Must be one of: ${validTypes.join(", ")}`,
  );
  process.exit(1);
}

const typeMap = {
  prd: { dir: "prd", ext: ".prd.md", template: "prd.template.md" },
  design: { dir: "design", ext: ".tdd.md", template: "design.template.md" },
  spec: { dir: "spec", ext: ".spec.md", template: "spec.template.md" },
};

const config = typeMap[docType];
const docDir = path.join(__dirname, "../docs", config.dir);
const templatePath = path.join(__dirname, "../docs/templates", config.template);

if (!fs.existsSync(docDir)) {
  console.log(`✓ No docs/${config.dir}/ directory found.`);
  process.exit(0);
}

if (!fs.existsSync(templatePath)) {
  console.error(`✗ Template file not found: docs/templates/${config.template}`);
  process.exit(1);
}

// Extract section headers from template
const templateContent = fs.readFileSync(templatePath, "utf-8");
const requiredSections = new Set();
const sectionRegex = /^(## [^\n]+)/gm;
let match;
while ((match = sectionRegex.exec(templateContent)) !== null) {
  const section = match[1];
  if (!section.includes("<!--")) {
    requiredSections.add(section);
  }
}

const docFiles = fs.readdirSync(docDir).filter((f) => f.endsWith(config.ext));
if (docFiles.length === 0) {
  console.log(`✓ No ${docType} documents found.`);
  process.exit(0);
}

// Filenames must be {YYYYMMDD}-{HHmm}-{slug} so that parallel work cannot
// collide on a shared counter (see docs/README.md "파일명 규칙").
const FILENAME_PATTERN = new RegExp(
  `^\\d{8}-\\d{4}-[a-z0-9-]+\\${config.ext}$`,
);

let hasErrors = false;

docFiles.forEach((file) => {
  if (!FILENAME_PATTERN.test(file)) {
    console.error(
      `✗ ${file} - Filename must be {YYYYMMDD}-{HHmm}-{slug}${config.ext}`,
    );
    hasErrors = true;
  }

  const filePath = path.join(docDir, file);
  const content = fs.readFileSync(filePath, "utf-8");

  if (!content.startsWith("---\n")) {
    console.error(`✗ ${file} - Frontmatter must start on line 1`);
    hasErrors = true;
  }

  for (const section of requiredSections) {
    if (!content.includes(section)) {
      console.error(`✗ ${file} - Missing section: ${section}`);
      hasErrors = true;
    }
  }
});

if (hasErrors) {
  console.error(
    `\n❌ Document structure validation failed for --type=${docType}`,
  );
  process.exit(1);
}

console.log(`✓ Document structure validation passed for --type=${docType}`);
process.exit(0);
