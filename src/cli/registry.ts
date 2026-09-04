/**
 * 실행 가능한 명령의 단일 정의. `schema` 명령, 인자 파싱, `nextActions`
 * 검증 테스트가 모두 이 목록을 근거로 삼는다 — 설명 문자열을 파싱 설정과
 * 따로 두지 않는다
 * (docs/spec/20260903-1218-machine-readable-output.spec.md "데이터 모델").
 *
 * `schema`는 실행 가능한 명령만 광고한다 — 아직 구현되지 않은 명령은
 * 등록하지 않는다 (같은 Spec "엣지 케이스").
 */
import type {
  CommandDescriptor,
  ErrorCode,
  WarningCode,
} from "../core/types.js";

export const COMMANDS: readonly CommandDescriptor[] = [
  {
    name: "inspect",
    summary: "세션 파일을 인덱싱해 조각·끊긴 노드·중복을 보고한다",
    writes: false,
    positionals: [
      { name: "file", required: true, description: "세션 JSONL 파일 경로" },
    ],
    options: [
      {
        name: "json",
        type: "boolean",
        required: false,
        default: false,
        description: "봉투 JSON 한 줄을 stdout에 출력",
      },
      {
        name: "duplicate-policy",
        type: "string",
        required: false,
        default: "prefer-parent",
        description:
          "중복 uuid 해소 정책 (first-wins | last-wins | prefer-parent)",
      },
    ],
    example: "sessgraph inspect session.jsonl --json",
  },
  {
    name: "reattach",
    summary: "레코드를 다른 부모 아래로 재연결한다 (기본은 dry-run)",
    writes: true,
    positionals: [
      { name: "file", required: true, description: "세션 JSONL 파일 경로" },
    ],
    options: [
      {
        name: "uuid",
        type: "string",
        required: true,
        default: null,
        description: "재연결할 대상 레코드의 uuid",
      },
      {
        name: "parent",
        type: "string",
        required: true,
        default: null,
        description: "새 부모로 지정할 레코드의 uuid",
      },
      {
        name: "reason",
        type: "string",
        required: true,
        default: null,
        description: "재연결 사유 (surgery.log에 남는다)",
      },
      {
        name: "commit",
        type: "boolean",
        required: false,
        default: false,
        description: "실제로 파일을 수정한다. 없으면 dry-run",
      },
      {
        name: "json",
        type: "boolean",
        required: false,
        default: false,
        description: "봉투 JSON 한 줄을 stdout에 출력",
      },
    ],
    example:
      "sessgraph reattach session.jsonl --uuid <uuid> --parent <uuid> --reason '설명' --commit",
  },
  {
    name: "verify",
    summary: "지정한 지점이 root까지 몇 개 노드로 연결되어 있는지 보고한다",
    writes: false,
    positionals: [
      { name: "file", required: true, description: "세션 JSONL 파일 경로" },
    ],
    options: [
      {
        name: "uuid",
        type: "string",
        required: true,
        default: null,
        description: "연결 상태를 확인할 대상 레코드의 uuid",
      },
      {
        name: "json",
        type: "boolean",
        required: false,
        default: false,
        description: "봉투 JSON 한 줄을 stdout에 출력",
      },
    ],
    example: "sessgraph verify session.jsonl --uuid <uuid> --json",
  },
  {
    name: "revert",
    summary: "reattach가 남긴 백업/수술 로그를 이용해 재연결을 되돌린다",
    writes: true,
    positionals: [
      { name: "file", required: true, description: "세션 JSONL 파일 경로" },
    ],
    options: [
      {
        name: "last",
        type: "boolean",
        required: false,
        default: false,
        description:
          "가장 최근 수술 1건만 되돌린다 (--to와 동시 사용 불가, 기본값)",
      },
      {
        name: "to",
        type: "string",
        required: false,
        default: null,
        description:
          "이 시각(ISO8601, 포함) 이후에 발생한 모든 수술을 되돌린다",
      },
      {
        name: "commit",
        type: "boolean",
        required: false,
        default: false,
        description: "실제로 파일을 복원한다. 없으면 dry-run",
      },
      {
        name: "json",
        type: "boolean",
        required: false,
        default: false,
        description: "봉투 JSON 한 줄을 stdout에 출력",
      },
    ],
    example: "sessgraph revert session.jsonl --last --commit",
  },
  {
    name: "serve",
    summary: "127.0.0.1에 읽기 전용 뷰어 서버를 띄워 조각 타임라인을 본다",
    writes: false,
    positionals: [
      {
        name: "file",
        required: true,
        description:
          "세션 JSONL 파일 경로. 하나 이상 지정할 수 있다 — 둘 이상이면 화면이 세션 목록을 먼저 보여준다",
        variadic: true,
      },
    ],
    options: [
      {
        name: "port",
        type: "string",
        required: false,
        default: "7377",
        description:
          "바인딩할 포트. 사용 중이면 다른 포트를 자동 선택하지 않고 오류로 종료한다",
      },
    ],
    example: "sessgraph serve session.jsonl --port 7377",
  },
  {
    name: "schema",
    summary: "이 CLI의 명령·오류 코드·종료 코드 목록을 봉투 JSON으로 출력",
    writes: false,
    positionals: [],
    options: [],
    example: "sessgraph schema",
  },
];

export const ERROR_CODES: readonly ErrorCode[] = [
  "UNKNOWN_COMMAND",
  "MISSING_ARGUMENT",
  "UNKNOWN_ARGUMENT",
  "FILE_NOT_FOUND",
  "FILE_NOT_WRITABLE",
  "TARGET_NOT_FOUND",
  "PARENT_NOT_FOUND",
  "AMBIGUOUS_DUPLICATE",
  "CYCLE_DETECTED",
  "NOT_REATTACHABLE",
  "EMPTY_REASON",
  "SCHEMA_DRIFT",
];

export const WARNING_CODES: readonly WarningCode[] = ["KEYS_DROPPED"];

export const EXIT_CODES: readonly { code: 0 | 1 | 2; meaning: string }[] = [
  { code: 0, meaning: "성공" },
  { code: 1, meaning: "검사 실패 (orphan 발견 등 — 도구는 정상 동작)" },
  { code: 2, meaning: "도구 오류 (파일 없음, 스키마 이상 등)" },
];

export function isRegisteredCommand(name: string): boolean {
  return COMMANDS.some((c) => c.name === name);
}
