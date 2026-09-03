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
        projectService: true,
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
    // src/web은 브라우저에서 그대로 실행되는 자산이라 tsc 프로젝트
    // (tsconfig의 include는 src/**/*.ts)에 속하지 않는다. 타입 정보를
    // 요구하는 규칙은 끄고 문법·기본 규칙만 적용한다.
    files: ["src/web/**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false, project: false },
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
