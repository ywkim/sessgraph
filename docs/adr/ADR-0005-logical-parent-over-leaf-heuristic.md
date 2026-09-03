---
status: Accepted
date: 2026-09-03
---

# ADR-0005: 재연결 부모 제안은 `logicalParentUuid`를 우선하고 직전 leaf는 fallback으로만 쓴다

## Status

Accepted

## Context

`compact_boundary` 레코드([ADR-0002](ADR-0002-record-preserving-reattach.md))는 `parentUuid: null`이지만, 관측 결과 `logicalParentUuid` 필드에 이어야 할 부모 uuid를 이미 담고 있다.

`serve` 명령 Design(`20260902-0420-serve-command.tdd.md`)은 이 필드를 쓰지 않고, "root의 `--parent`에는 **직전 세그먼트의 leaf uuid**를 채워 둔다"는 순서 기반 추측을 택했다. 이 가정을 두 개의 실측 세션 파일로 검증했다.

| 파일 | compact_boundary 총건 | `logicalParentUuid` 보유 | 직전 leaf와 일치 | 불일치 |
| --- | --- | --- | --- | --- |
| 286MB, 3,343 uuid (docs 프로젝트) | 16 | 16/16 | 9 | **7 (44%)** |
| 822MB, 10,171 uuid (p 프로젝트, `1b9bb8fd` `.bak`) | 316 | 316/316 | 286 | **30 (9.5%)** |

두 파일 모두 `logicalParentUuid`는 항상 존재하고 항상 파일 내 실존 uuid를 가리켰다. 반면 "직전 leaf" 가정은 두 파일 모두에서 깨졌다 — 후자 사례에서는 같은 `logicalParentUuid`(`21be4c56...`)가 반복적으로 등장하며 갈수록 더 먼 과거 줄(최대 74,921줄 이전)을 가리켰다. 재분기(resume/fork를 반복)한 세션에서 "가장 최근에 쓰인 순서"와 "논리적으로 이어야 할 지점"이 구조적으로 달라지는 것으로 보인다(메커니즘 미확인 — 추정).

## 후보 기술 & 각 선택지

**후보1: 직전 세그먼트의 leaf uuid를 그대로 쓴다 (현 serve Design)**

- 장점: 추가 필드 없이 이미 계산된 `segments` 배열 순서만으로 계산 가능
- 단점: 실측 두 파일에서 각각 44%, 9.5% 틀렸다. 순서 가정이 세션 구조를 반영하지 못하는 경우가 드물지 않다

**후보2: `logicalParentUuid`를 1차 출처로 쓰고, 없을 때만 직전 leaf로 fallback**

- 장점: 실측된 모든 `compact_boundary`가 이 필드를 갖고 있었고, 두 파일 모두에서 100% 정확했다
- 단점: 비공개 필드([ADR-0001](ADR-0001-typescript-single-language.md) 근거와 동일한 리스크)라 사라지거나 이름이 바뀔 수 있다. fallback 경로가 필요한 이유이기도 하다

## Decision

`Segment`에 `rootLogicalParentUuid: string | null`을 추가하고, root가 `compact_boundary`이며 원본 레코드에 `logicalParentUuid`가 있으면 그 값을 담는다. `serve`의 `suggestedReattachCommand`와 사용자에게 제안하는 모든 기본 `--parent` 값은 이 필드를 우선 사용하고, 값이 없을 때만 직전 세그먼트의 leaf uuid로 fallback한다.

## Rationale (선택 이유)

두 개의 서로 다른 규모·출처 세션 파일에서 `logicalParentUuid`는 100% 존재했고 100% 정확했다. "직전 leaf" 가정은 같은 두 파일에서 각각 7건, 30건을 틀렸다. 도구가 잘못된 기본값을 제안하면 사용자가 그대로 `--commit`했을 때 엉뚱한 지점에 이어붙이는 사고로 이어진다 — `reattach`가 되돌리기 가능하도록 설계됐다 해도([ADR-0002] "부수적으로 레코드 보존형은 되돌리기 쉽다"), 틀린 기본값을 조용히 제안하는 것 자체가 ADR-0004의 원칙("틀린 답을 조용히 내놓지 않는다")과 충돌한다.

## Consequences

### 장점

- `suggestedReattachCommand`의 정확도가 실측 기준 91~100%에서 100%로 개선(관측된 두 파일 기준)
- fallback 경로를 유지하므로 `logicalParentUuid`가 없는 레코드(구버전 세션 등)에서도 동작이 끊기지 않는다

### 단점 & 트레이드오프

- 비공개 필드 의존이 하나 늘어난다. `logicalParentUuid`가 사라지면 자동으로 후보1(직전 leaf) 동작으로 돌아가므로 "조용한 정확도 저하"가 재발할 수 있다 — fallback 사용 여부를 결과에 노출해야 한다(향후 원칙 참고)
- 두 실측 파일 모두 개인 세션이라 표본이 크지 않다. 다른 사용 패턴(짧은 세션, 단일 컴팩트)에서는 재검증이 필요할 수 있다

### 향후 기능이 따를 원칙

- fallback을 썼는지 여부(`rootLogicalParentUuid === null`이라 직전 leaf를 썼는지)를 `SegmentDetail`/CLI 출력에 명시한다 — 추측값을 확정값처럼 보이게 하지 않는다
- 새 비공개 필드를 읽기 시작할 때는 그 필드가 사라졌을 때의 동작을 반드시 정의한다(ADR-0004 원칙 재적용)

## 언제 이 결정을 다시 검토할 것인가?

- `logicalParentUuid`가 없는 `compact_boundary`가 실제로 관측될 때 (지금까지 0건)
- fallback(직전 leaf) 경로가 실사용에서도 자주 틀리는 것이 확인될 때 — 이 경우 fallback 자체를 재검토해야 한다
- Claude Code가 `logicalParentUuid`의 의미나 존재를 바꿀 때
