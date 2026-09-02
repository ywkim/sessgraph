# CLAUDE.md — sessgraph

Claude Code 세션 JSONL의 구조를 색인해 **어디가 끊겼는지 진단하고, 끊긴 체인을 이어붙이는** 도구.
읽기·시각화는 로컬 웹 뷰어가, 파일 수정은 CLI가 담당한다 ([ADR-0003](docs/adr/ADR-0003-cli-writes-web-reads.md)).

TypeScript 단일 스택 — 인덱서·CLI·웹이 한 언어, 한 파싱 구현을 공유한다 ([ADR-0001](docs/adr/ADR-0001-typescript-single-language.md)).

## 문제 배경

컴팩트를 거친 세션은 경계 레코드(`type: system`, `subtype: compact_boundary`)의 `parentUuid`가 `null`이라 **하나의 체인이 아니라 여러 조각**으로 끊긴다. 재개하면 마지막 조각만 로드되고 그 이전 대화는 사라진 것처럼 보인다.

기존 도구들은 이 구조를 만들지 않는다 — JSONL을 순서대로 읽어 렌더링할 뿐이라 "어디가 왜 끊겼는가"에 답하지 못한다.

## 구조

리포 루트가 유일한 워크스페이스다. 그 안에서 세 스코프를 디렉터리로 나눈다:

- `src/core/` — JSONL 파싱, 그래프 구축, 타입 정의. **두 스코프 사이의 중립 지대이자 타입의 단일 진실.** 상세 규칙은 [src/core/CLAUDE.md](src/core/CLAUDE.md)
- `src/cli/` — 명령줄 인터페이스. **파일을 쓰는 유일한 스코프.** 상세 규칙은 [src/cli/CLAUDE.md](src/cli/CLAUDE.md)
- `src/web/` — 로컬 읽기 전용 뷰어. 상세 규칙은 [src/web/CLAUDE.md](src/web/CLAUDE.md)
- 이 루트 파일은 전체 공통 계약을 다룬다. 각 스코프 고유 규칙은 해당 디렉터리 CLAUDE.md에 적고 여기와 중복하지 않는다

`src/cli/`와 `src/web/`은 **JSONL을 직접 파싱하지 않는다.** 반드시 `src/core/`를 경유한다.

## 실행

```bash
npm install
npm run build          # tsc
npm test               # 골든 픽스처 회귀 포함
npm run lint           # eslint
npm run lint:docs      # 문서 거버넌스 검사 (PRD 순수성, ADR 불변성, 구조)
npm run type-check     # tsc --noEmit
```

PR을 올리기 전에 로컬에서 위 명령을 먼저 실행해 CI 실패를 예방한다.

## ⚠️ 픽스처 정책 (public 리포)

이 리포는 public이고, 이 도구가 다루는 세션 파일에는 **자격증명·파일 경로·개인정보가 그대로** 들어 있다.

- 실제 세션 파일을 리포에 커밋하지 않는다. `.gitignore`가 `*.jsonl`을 막지만, 그것에 의존하지 않는다
- 테스트 픽스처는 **구조 필드만 남긴 익명화본**을 쓴다 — `uuid`(재생성), `parentUuid`, `type`, `subtype`, `timestamp`(상대화). 메시지 본문·파일 경로·도구 인자는 전부 버린다
- 문서에 실측 결과를 인용할 때는 **구조 수치만** 쓴다 (줄 수, 노드 수, 소요 시간). 프로젝트명·경로·대화 내용은 쓰지 않는다
- 픽스처 생성은 사람이 눈으로 확인한 뒤 커밋한다. 자동 생성 결과를 검토 없이 커밋하지 않는다

## 정확성 원칙

이 도구의 유일한 존재 이유는 "어디가 끊겼는지 정확히 아는 것"이다. **틀린 답을 조용히 내놓으면 도구가 없는 것보다 나쁘다** — 사용자가 그 답을 믿고 수술 대상을 잘못 고르기 때문이다.

- 집계 결과가 "문제 없음"을 뜻할 때(`orphans: 0` 등), 그 값이 **고장으로도 나올 수 있는지** 먼저 확인한다. 정상과 고장을 값으로 구분할 수 없으면 불변식으로 판정한다
- 필수 필드가 통째로 사라지면 0을 반환하지 않고 **중단한다**
- 중복·모호한 레코드를 임의로 하나 고르지 않는다. 정책이 명세에 없으면 그 사실을 보고한다
- 성능·정확성 주장은 실제 파일로 **측정한 뒤에** 한다. 코드만 보고 "될 것 같다"고 하지 않는다

근거: [ADR-0004](docs/adr/ADR-0004-schema-drift-defense.md) — 같은 파일에 대해 중복 처리 정책만 달리한 세 구현이 세 가지 답을 냈고, 그중 하나는 끊긴 노드가 있는데도 "문제 없음"을 보고했다.

## 수술 규칙

세션 파일을 수정하는 동작은 다음을 반드시 지킨다 ([ADR-0002](docs/adr/ADR-0002-record-preserving-reattach.md)):

- **레코드를 삭제·삽입하지 않는다.** `parentUuid` 값 변경만 수행한다
- 쓰기 전 **타임스탬프 붙은 백업**을 만든다. 기존 백업을 덮어쓰지 않는다
- 임시 파일에 쓴 뒤 원자적으로 교체한다
- 기본은 `--dry-run`. `--commit`이 있어야 실제로 쓴다
- `{세션}.surgery.log`에 append-only로 무엇을 왜 바꿨는지 남긴다
- **구조적 성공(체인 길이)을 실질 성공으로 보고하지 않는다.** 도구는 체인 길이까지만 보고하고, 회상 검증은 재개 후 사람이 직접 해야 함을 안내한다

## 외부 스키마 의존

이 도구가 읽는 필드(`uuid`, `parentUuid`, `type`, `subtype`, `compact_boundary`, `compactMetadata`, `preservedMessages`)는 [공식 문서가 "internal, changes between versions"로 명시](https://code.claude.com/docs/en/sessions.md)한 비공개 스키마다. 전부 리버스엔지니어링 결과이며 **언제든 깨질 수 있다는 전제**로 설계한다.

새 필드를 읽기 시작하면 그 필드가 사라졌을 때의 동작을 반드시 정의한다.

## Pull Request 작성 가이드

### 제목

Conventional Commits 형식: `<type>(<scope>): <subject>` (72자 이내)

**type** (영문): `feat`, `fix`, `refactor`, `chore`, `docs`, `test`
**scope** (선택): `core`, `cli`, `web`, `docs`
**subject** (한국어): 명령조 현재형, 마침표 없음

**예시**:

- `feat(core): compact_boundary 기준 세그먼트 분할 추가`
- `fix(cli): dry-run에서 백업 파일이 생성되던 문제 수정`

### 설명 구조

1. **요약 (1-2문장)** — 무엇이 달라지는지
2. **목적** — 왜 필요한지, 어떤 문제를 해결하는지
3. **테스트 체크리스트** — 실제 동작을 확인할 수 있는 시나리오

정확성에 영향을 주는 변경이면 **실측 결과를 첨부한다** (대상 파일의 구조 수치와 소요 시간).

## 인터페이스 변경 게이트

`src/core/`가 노출하는 타입과 함수 시그니처는 `src/cli/`와 `src/web/`이 함께 소비한다.
한쪽 스코프가 인터페이스를 바꿔야 하면:

1. 변경 필요성을 이 CLAUDE.md 또는 관련 Design 문서에 먼저 기록
2. `src/core/`를 먼저 수정한다 — 이 diff가 변경 범위의 근거가 된다. `src/cli/`도 `src/web/`도 이 디렉터리를 단독으로 소유하지 않는다
3. 반대쪽 스코프에 미치는 영향 확인
4. 두 스코프를 같은 PR에서 함께 수정하거나, 순서를 명시해 별도 PR로 분리
5. 각 스코프 세션이 자기 스코프 밖 파일을 임의로 고치지 않는다 — 이 절차를 통해서만

## 운영 모델

- 개인 계정(`ywkim`) public 리포. **활동은 GitHub에 공개된다**
- `main` 직접 push를 지양하고 PR로 작업한다 — 다만 이 리포는 branch protection이 **설정되어 있지 않다** (가용 여부 미확인). 즉 이 규칙은 기계적 강제가 아니라 **지침으로만 유지**되며, 위반해도 GitHub이 막지 않는다
- 위 사실을 근거로 "PR이 승인됐으니 안전하다"고 가정하지 않는다. 정확성 판단은 테스트와 실측이 한다

### 스택 PR 병합 절차

1. 부모 PR 병합 시 `--delete-branch`를 쓰지 않는다 — GitHub의 자동 재타겟 대신 하위 PR이 CLOSED된다 ([cli/cli#1168](https://github.com/cli/cli/issues/1168)). 스택 전체 병합 후 브랜치를 일괄 삭제한다
2. 부모가 squash 병합됐으면 하위 브랜치를 `git rebase --onto main <부모의_옛_tip> <하위_브랜치>`로 옮긴다 (squash는 새 해시로 압축되므로 base 전환만으로는 부모 파일이 diff에 재출현한다)
3. `gh pr diff <n> --name-only`로 그 PR 고유 파일만 나오는지 확인 후 병합한다

## 문서 거버넌스

새 기능을 개발할 때는 기획(PRD), 설계(Design/TDD), 명세(Spec), 기술결정(ADR)을 `docs/` 아래 구조화된 문서로 작성한다 — 상세한 원칙과 템플릿은 [docs/README.md](docs/README.md) 참고.

**핵심 경계**:

- **CLAUDE.md** — 현재 상태의 운영 규칙. 이 파일이 진실의 원천이다. "우리는 **지금** X로 한다"는 명령형 현재시제
- **docs/adr/** — 그 상태에 이르게 된 기술 선택의 이력. append-only, 수정 불가 (상태만 Accepted → Superseded로 변경 가능). 사실이 CLAUDE.md와 다르면 CLAUDE.md를 따른다. "우리가 **당시** X를 왜 선택했는가"의 설명형 과거시제
- **docs/prd/, design/, spec/** — 새 기능의 기획·설계·명세. 기존 운영 규칙(CLAUDE.md, `src/core/`)과 중복하지 않는다
- **src/core/** — 타입·스키마의 단일 진실. Spec 문서는 이를 재기술하지 말고 링크한다

## 문서 작성 규칙

모든 `docs/prd/`, `docs/design/`, `docs/spec/` 문서는 파일 최상단(1행)에 YAML frontmatter를 갖는다:

```yaml
---
slug: <YYYYMMDD-HHmm-슬러그>
status: <Current | Superseded by {ID}>
superseded_reason: <대체 사유, Superseded일 때만>
updated: <YYYY-MM-DD>
related:
  prd: docs/prd/{slug}.prd.md # design/spec에만 필수
  design: docs/design/{slug}.tdd.md # spec에만 필수
---
```

**파일명**: `{YYYYMMDD}-{HHmm}-{slug}` — 중앙 조율 없이 충돌 없는 ID를 얻기 위함. ADR만 `ADR-{4자리}-{slug}` 순번 예외. 근거는 [docs/README.md](docs/README.md) "파일명 규칙" 참고.

**status**는 진행도가 아니라 currency(지금도 참조할 최신 버전인가)를 뜻한다.

**자동화**: `npm run lint:docs`가 PRD 기술 용어, Design 링크 유효성, ADR 불변성·번호 충돌, 문서 구조·파일명을 검사한다. CI가 모든 PR에서 실행한다.

**일반 규칙**: 한국어, Markdown. frontmatter는 파일 첫 줄부터 시작 (파서 호환성).
