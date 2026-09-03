#!/usr/bin/env node
/**
 * `src/web/`의 정적 자산(HTML/CSS)을 `dist/web/`로 복사하고, `tsc -p
 * tsconfig.web.json`이 만든 컴파일된 `app.js`를 그 옆으로 옮긴다.
 *
 * `app.ts`는 `import type`으로 `src/core/types.ts`를 참조한다(ADR-0001 —
 * 웹도 TypeScript 컴파일러 검증을 거친다). 그 때문에 `tsconfig.web.json`의
 * rootDir는 `src` 전체가 되고, 컴파일 산출물은 `dist/.web-build/web/app.js`
 * 형태로 나온다(core/types.js도 함께 나오지만 런타임에 필요 없다 — `import
 * type`은 완전히 소거되므로 app.js가 그걸 import하지 않는다). 여기서 필요한
 * 파일 하나만 꺼내 옮기고 임시 디렉터리는 지운다.
 *
 * `serve` 명령이 `dist/cli/serve.js` 기준 상대 경로로 자산을 읽으므로
 * (설치된 패키지에서 `src/`가 없을 수 있다) 빌드 시점에 복사해 둔다.
 *
 * `CLAUDE.md` 같은 문서는 자산이 아니므로 제외한다.
 */
import { cpSync, mkdirSync, renameSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "src", "web");
const to = path.join(root, "dist", "web");

const ASSET_EXTENSIONS = new Set([".html", ".css"]);

mkdirSync(to, { recursive: true });
cpSync(from, to, {
  recursive: true,
  filter: (src) => {
    const ext = path.extname(src);
    return ext === "" || ASSET_EXTENSIONS.has(ext);
  },
});

const webBuild = path.join(root, "dist", ".web-build");
const compiledAppJs = path.join(webBuild, "web", "app.js");
if (existsSync(compiledAppJs)) {
  renameSync(compiledAppJs, path.join(to, "app.js"));
}
rmSync(webBuild, { recursive: true, force: true });
