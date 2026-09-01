---
slug:
status: Current
superseded_reason:
related:
  prd: docs/prd/{slug}.prd.md
  design: docs/design/{slug}.tdd.md
updated:
---

<!--
⚠️ 구현 명세(Spec) 작성 원칙 ⚠️
이 문서는 What(정확히 무엇을)만 다룬다.
Why는 related.prd에서, Why-this-design은 related.design에서 가져온다 (중복 쓰지 않는다).
이 문서의 목표: 이 문서만 읽고 정확히 구현할 수 있어야 한다.

타입/스키마의 단일 진실은 `src/core/`다. 여기에 재기술하지 말고 링크한다.
-->

# Spec: {제목}

## Interface

<!--
정확한 명령어 / 함수 시그니처 / 응답 형식.
모호함 0.

타입 정의는 src/core/를 링크한다. 복사하지 않는다.
-->

## 데이터 모델

<!--
필드명, 타입, 제약 조건, nullable 여부.
src/core/의 타입을 링크하고, 여기서는 불변식(invariant)만 명시한다.
-->

## 엣지 케이스 & 에러 처리

<!--
빠짐없이 나열. 각 케이스의 정확한 동작.
특히 "조용히 잘못된 답을 내는" 경로를 명시적으로 다룬다.
-->

## 성능 요구사항

<!--
처리 시간, 메모리 상한.
가능하면 실측 기준선을 명시한다 (측정 대상 파일과 함께).
-->

## Out of Scope

<!--
의도적으로 이 명세에 포함하지 않는 것.
-->
