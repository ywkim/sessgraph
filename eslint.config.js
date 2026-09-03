// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "scripts/**", "eslint.config.js"],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // projectService(자동 탐색)는 tsconfig.json의 include(`src/**/*.ts`,
        // `src/web` 제외)만 보므로 tsconfig.web.json 쪽 파일(app.ts)을 못
        // 찾는다. 두 프로젝트를 명시적으로 나열한다.
        project: ["./tsconfig.json", "./tsconfig.web.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { varsIgnorePattern: "^_", argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // node:test의 최상위 test()는 관용적으로 await하지 않는다 (러너가 프로세스 종료 전 대기)
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
);
