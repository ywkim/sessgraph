---
slug:
status: Current
superseded_reason:
related:
  prd: docs/prd/{slug}.prd.md
updated:
---

<!--
⚠️ 기술 설계 문서(TDD) 작성 원칙 ⚠️
이 문서는 Why-this-design(왜 이 설계인가)과 How(아키텍처)를 다룬다.
Why(목표)는 related.prd에서 가져온다 (중복 쓰지 않는다).
What(구체적 구현)은 related.spec에서 다룬다.
-->

# Technical Design: {제목}

## Context

> 📋 출처: {PRD 링크}
>
> 목표: {PRD의 핵심 한 문장 요약}

## 적용하는 기존 ADR

<!--
이 기능에서 새로 기술/패턴을 발명하지 않는다.
기존 docs/adr/ 문서를 인용하고 참조하기만 한다.

새로운 기술 선택이 불가피하다면:
1. 먼저 docs/adr/ADR-{번호}-{slug}.md를 작성
2. 이 섹션에서 인용
3. 검토 후 Accepted 마킹

예:
- [ADR-0001: 단일 언어(TypeScript) 스택](../adr/ADR-0001-typescript-single-language.md)
-->

## 아키텍처 (How)

<!--
기술적 구조를 다이어그램과 문장으로 설명.

- 컴포넌트 역할 분담
- 데이터 흐름
- 제약 조건 (성능, 메모리, 호환성)

구체적 구현은 spec으로 넘긴다.
-->

## 데이터 흐름

<!--
입력 → 처리 → 출력.
상태 변화, 에러 처리 경로 포함.
-->

## 고려한 대안 & 기각 이유

<!--
왜 다른 설계는 안 되고 이것을 선택했는가?
트레이드오프 명시. 가능하면 실측 근거를 붙인다.
-->

## 향후 확장 고려사항

<!--
이 설계 결정이 향후 기능에 미칠 영향.
-->
