# 문서 거버넌스 체계

AI 에이전트 오케스트레이션을 전제로 한 문서 관리 프레임워크입니다.

> **참고**: 루트 [`CLAUDE.md`](../CLAUDE.md)는 현재 상태의 운영 규칙입니다. 이 문서는 새 기능 개발 시 따를 절차를 설명합니다. 기존 아키텍처나 기술 선택이 필요하면 CLAUDE.md를 먼저 읽으세요.

## 핵심 원칙

### 1️⃣ 단일 진실의 원천 (SSOT)

- **동일한 사실이 두 파일에 중복되지 않는다**
- 집계/요약이 필요하면 **자동 생성**하고, 사람이 수동으로 두 곳을 유지보수하지 않는다
- 참고 문서는 링크로 연결 (내용 복사 금지)
- 타입·스키마의 SSOT는 `src/core/`다. Spec 문서는 이를 재기술하지 않고 링크한다

### 2️⃣ 관심사의 물리적 분리

한 문서 안에 섞이면 안 되는 세 가지 관점을 **물리적으로 다른 파일**로 강제:

| 파일 종류        | 다루는 것                                    | 기술 용어 | 빈도               |
| ---------------- | -------------------------------------------- | --------- | ------------------ |
| **PRD**          | Why (목표) + What (요구사항)                 | ❌ 금지   | 기능당 1회         |
| **Design (TDD)** | Why-this-design (선택 근거) + How (아키텍처) | ✅ 필수   | 기능당 1회         |
| **Spec**         | What (정확한 구현 명세)                      | ✅ 필수   | 기능당 1회         |
| **ADR**          | 기술 선택의 영구 기록                        | ✅ 필수   | 프로젝트당 수십 건 |

### 3️⃣ 자동화 가능하도록 설계

- **규칙은 파일 구조와 템플릿으로 강제**하고, 파서가 읽을 수 있는 형태로 표준화
- YAML frontmatter는 파일의 맨 첫 줄부터 시작 (파서 호환성)
- 파일명 규칙으로 일관성 확보
- `npm run lint:docs`가 CI에서 자동 실행

---

## 디렉터리 구조

```
docs/
├── README.md                 # 이 파일. 거버넌스 가이드
├── templates/                # 모든 문서 종류의 정식 템플릿
│   ├── prd.template.md
│   ├── design.template.md
│   ├── spec.template.md
│   └── adr.template.md
├── adr/                      # 영구 보존, append-only
│   └── ADR-{NNNN}-{slug}.md
├── prd/                      # 기능별 기획 문서
│   └── {YYYYMMDD}-{HHmm}-{slug}.prd.md
├── design/                   # 기능별 기술 설계
│   └── {YYYYMMDD}-{HHmm}-{slug}.tdd.md
└── spec/                     # 기능별 구현 명세
    └── {YYYYMMDD}-{HHmm}-{slug}.spec.md
```

### 파일명 규칙

이 리포는 이슈 트래커를 쓰지 않는다. 이슈 트래커가 있으면 중앙 DB가 ID를 안전하게 발급하지만, Git은 분산 버전 관리 시스템이라 이슈 트래커를 안 쓰는 순간 **ID 발급 권한이 각 작업 환경으로 파편화**된다.

순번 방식(`1.prd.md`, `2.prd.md`)은 두 세션이 병렬로 새 문서를 시작하면 각자 "다음 번호"를 추측해 같은 번호를 매길 수 있고, 최악의 경우 서로 다른 두 문서가 **같은 파일 경로가 아니라서 git이 충돌로 인식조차 못 한 채** 조용히 함께 병합된다.

**해결**: `{YYYYMMDD}-{HHmm}-{slug}` — 로컬 시계만으로 중앙 조율 없이 충돌 없는 고유 ID를 얻는다 (Rails/Django 마이그레이션, Terraform state와 동일한 패턴).

같은 기능에 대한 문서들은 **동일한 슬러그**로 연결한다:

```
docs/prd/20260901-1430-orphan-detection.prd.md
docs/design/20260901-1430-orphan-detection.tdd.md
docs/spec/20260901-1430-orphan-detection.spec.md
```

**ADR만 예외**로 `ADR-{4자리 번호}-{slug}` 순번을 유지한다 — 드물게 생성되고 본문에서 번호로 직접 인용되므로 리네임하면 참조가 깨진다. 대신 `check-adr-immutable.js`가 번호 충돌을 CI에서 감지한다.

### status 필드

`status`는 **진행도가 아니라 currency**(지금도 참조할 최신 버전인가)를 나타낸다.

| 값                   | 의미                   |
| -------------------- | ---------------------- |
| `Current`            | 지금 참조해야 할 버전  |
| `Superseded by {ID}` | 다른 문서/ADR로 대체됨 |

`draft`/`in-progress`/`done`을 쓰지 않는 이유: 문서가 PR로 리뷰·머지되는 리포에서 진행도는 PR lifecycle과 같은 사실을 중복 기록하는 SSOT 위반이다. 더 나쁜 건 `done`으로 굳은 문서의 전제가 나중에 뒤집혀도 `done`이 그대로 남아, 문서만 봐서는 무효화 사실을 알 수 없다는 점이다.

Superseded되어도 **본문은 수정하지 않는다**. 사유는 `superseded_reason`에 남긴다.

> `valid`나 `active`가 아닌 `Current`인 이유 — `valid`는 진리값 축이라 "Superseded면 거짓인가?" 혼란을 부르고(대체된 문서도 당시엔 참이었을 수 있다), `active`는 "실행 중"으로 굳어진 어휘다. `Current`는 문서관리(document control) 표준 어휘로 진리 주장도 실행 여부 주장도 하지 않는다.

---

## 문서 작성 플로우

### 새 기능 개발 시

1️⃣ **기획** — `templates/prd.template.md` 복사 → `prd/{YYYYMMDD}-{HHmm}-{slug}.prd.md`

- Why(목표) + What(요구사항/성공 기준)
- ⚠️ 기술 용어 금지 (`lint-prd-purity.js`가 검사)

2️⃣ **설계** — `templates/design.template.md` 복사 → `design/{같은 slug}.tdd.md`

- `related.prd` 링크 필수 (`lint-design-doc.js`가 실재 여부 검증)
- 기존 ADR 인용. 새 기술이 필요하면 ADR을 **먼저** 작성

3️⃣ **명세** — `templates/spec.template.md` 복사 → `spec/{같은 slug}.spec.md`

- `related.prd`, `related.design` 링크 필수
- **이 문서만 보고 정확히 구현할 수 있는 수준**
- 타입은 `src/core/`를 링크. 재기술 금지

### 기술 선택 필요 시

- `templates/adr.template.md` 복사 → `adr/ADR-{다음 번호}-{slug}.md`
- Context, 후보들, Decision, Rationale, Consequences 작성
- **가능하면 실측 근거를 붙인다** — 이 도구는 세션 파일을 다루므로 성능·정확성 주장은 실제 파일로 측정할 수 있다
- **Accepted** 마킹 후 Design 문서에서 인용

---

## 문서 간 관계도

```
기획        ┌─────────────────┐
(Why+What)  │ docs/prd/{slug} │
            └────────┬────────┘
                     │ related.prd
                     ▼
설계         ┌─────────────────┐
(Why-this-   │ docs/design/... │ ◄──── 기존 ADR 인용
design+How)  └────────┬────────┘       또는 새 ADR 생성
                     │ related.design
                     ▼
명세         ┌─────────────────┐
(exact What) │ docs/spec/...   │ ────► src/core/ 링크 (타입 SSOT)
            └─────────────────┘

별도 track  ┌─────────────────┐
기술 기록    │ docs/adr/ADR-N  │ (영구 보존, append-only)
            └─────────────────┘
```

---

## 체크리스트

새로운 기능 개발 시:

- [ ] PRD 작성 (없으면 요구사항 불명확)
- [ ] Design 작성 (없으면 구현 재작업 위험)
- [ ] Spec 작성 (없으면 버그 증가)
- [ ] 필요한 ADR 작성 또는 기존 ADR 인용
- [ ] 링크 검증: prd → design → spec 모두 상호 참조
- [ ] 기술 용어 확인 (PRD에 없어야 함)
- [ ] 중복 제거 (같은 사실을 여러 문서에 쓰지 않음)
- [ ] **실제 세션 내용이 문서에 들어가지 않았는지 확인** (아래 참고)

## ⚠️ 공개 리포 제약

이 리포는 public이다. 이 도구가 다루는 Claude Code 세션 파일에는 자격증명·파일 경로·개인정보가 그대로 들어 있다.

- 문서·픽스처·테스트에 **실제 세션 본문을 붙여넣지 않는다**
- 실측 결과를 인용할 때는 **구조 수치만** 쓴다 (줄 수, 노드 수, 소요 시간). 파일 경로·프로젝트명·대화 내용은 쓰지 않는다
- 픽스처는 합성하거나, 실제 파일에서 구조 필드만 남기고 본문을 버린 익명화본을 쓴다 — 상세 규칙은 [CLAUDE.md](../CLAUDE.md) "픽스처 정책" 참고

---

## FAQ

**Q: PRD와 Design 모두 "목표"를 써야 하나?**

A: 아니다. PRD의 Why는 목표, Design의 Context는 그 PRD의 목표를 한 줄로 요약만 한다. 중복하지 않는다.

**Q: 이미 작성한 문서를 수정할 때는?**

A: ADR은 수정 금지 (`Superseded by`로만 가능). PRD/Design/Spec은 `updated:` 필드를 갱신하고 수정한다. 전제가 무효화됐으면 `status: Superseded by {ID}`로 마킹하고 본문은 두다.

**Q: 작은 버그 수정도 문서를 써야 하나?**

A: 아니다. 문서는 새로운 **기능**, **설계 결정**, **기술 선택**을 위해 쓴다.

---

## 참고

- [Conventional Commits](https://www.conventionalcommits.org/)
- [ADR 저장소 - Joel Parker Henderson](https://github.com/joelparkerhenderson/architecture_decision_record)
