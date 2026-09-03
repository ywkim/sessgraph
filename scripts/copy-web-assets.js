#!/usr/bin/env node
/**
 * `src/web/`의 정적 자산(HTML/CSS)을 `dist/web/`로 복사하고, `tsc -p
 * tsconfig.web.json`이 만든 컴파일된 `.js`(app.js, format.js 등)를 그
 * 옆으로 옮긴다.
 *
 * `app.ts`는 `import type`으로 `src/core/types.ts`를 참조한다(ADR-0001 —
 * 웹도 TypeScript 컴파일러 검증을 거친다). 그 때문에 `tsconfig.web.json`의
 * rootDir는 `src` 전체가 되고, 컴파일 산출물은 `dist/.web-build/web/*.js`
 * 형태로 나온다(core/types.js도 함께 나오지만 런타임에 필요 없다 — `import
 * type`은 완전히 소거되므로 실제로 그걸 import하는 산출물은 없다). 여기서
 * `web/` 아래 파일만 꺼내 옮기고 임시 디렉터리는 지운다.
 *
 * `serve` 명령이 `dist/cli/serve.js` 기준 상대 경로로 자산을 읽으므로
 * (설치된 패키지에서 `src/`가 없을 수 있다) 빌드 시점에 복사해 둔다.
 *
 * `*.test.js`는 `dist/web/`(=`serve`의 정적 서빙 루트)에 넣지 않는다 —
 * `src/cli/serve.ts`의 `serveStatic`은 파일명 allowlist 없이 그 디렉터리
 * 안의 파일을 그대로 응답하므로, 테스트 파일이 섞이면 브라우저가 요청할
 * 일 없는 파일까지 HTTP로 노출된다(2026-09-03 리뷰에서 실제로 발견).
 * `dist/web-tests/`로 따로 옮긴다 — `npm test`가 dist 아래 모든 테스트
 * 파일을 통째로 돌므로 위치와 무관하게 실행은 된다. 상대 import(`./format.js`)가
 * 풀리도록 non-test `.js`도 `dist/web-tests/`에 함께 둔다(파일 하나뿐이라
 * 중복 비용이 작다).
 */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "src", "web");
const to = path.join(root, "dist", "web");
const testsTo = path.join(root, "dist", "web-tests");

const ASSET_EXTENSIONS = new Set([".html", ".css"]);

mkdirSync(to, { recursive: true });
cpSync(from, to, {
  recursive: true,
  filter: (src) => {
    const ext = path.extname(src);
    return ext === "" || ASSET_EXTENSIONS.has(ext);
  },
});

const webBuild = path.join(root, "dist", ".web-build", "web");
cpSync(webBuild, to, {
  recursive: true,
  filter: (src) => !src.endsWith(".map") && !src.endsWith(".test.js"),
});
mkdirSync(testsTo, { recursive: true });
cpSync(webBuild, testsTo, {
  recursive: true,
  filter: (src) => !src.endsWith(".map"),
});
rmSync(path.join(root, "dist", ".web-build"), {
  recursive: true,
  force: true,
});
