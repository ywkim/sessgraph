#!/usr/bin/env node
/**
 * `src/web/`의 정적 자산을 `dist/web/`로 복사한다.
 *
 * `tsc`는 `.ts`만 내보내므로 HTML/CSS/JS는 빌드 산출물에 포함되지 않는다.
 * `serve` 명령이 `dist/cli/serve.js` 기준 상대 경로로 자산을 읽으므로
 * (설치된 패키지에서 `src/`가 없을 수 있다) 빌드 시점에 복사해 둔다.
 *
 * `CLAUDE.md` 같은 문서는 자산이 아니므로 제외한다.
 */
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "src", "web");
const to = path.join(root, "dist", "web");

const ASSET_EXTENSIONS = new Set([".html", ".css", ".js"]);

mkdirSync(to, { recursive: true });
cpSync(from, to, {
  recursive: true,
  filter: (src) => {
    const ext = path.extname(src);
    return ext === "" || ASSET_EXTENSIONS.has(ext);
  },
});
