# sessgraph

Claude Code 세션 JSONL의 구조를 색인해 **어디가 끊겼는지 진단하고, 끊긴 체인을 이어붙이는** 도구.

> ⚠️ 초기 스캐폴딩 단계입니다. 아직 구현이 없습니다.

## 문제

Claude Code 세션이 컴팩트될 때 기록되는 경계 레코드(`type: system`, `subtype: compact_boundary`)는 `parentUuid`가 `null`입니다. 그 결과 컴팩트를 여러 번 거친 세션은 하나의 연결된 대화가 아니라 **경계마다 끊긴 여러 조각**이 됩니다.

세션을 재개하면 마지막 조각만 로드되고, 그 이전 대화는 사라진 것처럼 보입니다.

실측한 한 세션(86,668줄)은 컴팩트 경계 315건을 포함하고 39개의 비연결 조각으로 나뉘어 있었습니다. 마지막 레코드에서 부모를 거슬러 올라가면 **13개 노드 만에 멈춥니다.**

## 기존 도구와의 차이

기존 세션 뷰어들은 JSONL을 순서대로 읽어 렌더링합니다. 관계 그래프를 만들지 않으므로 "어디가 왜 끊겼는가"에 답하지 못합니다.

sessgraph는 `parentUuid` 그래프와 컴팩트 경계를 **함께** 모델링해서 다음에 답합니다:

- 이 세션은 몇 개 조각으로 끊겨 있는가
- 어느 노드가 부모를 잃었는가 (orphan)
- 특정 노드에서 루트까지 몇 개나 도달하는가
- 어디를 이으면 얼마나 되살아나는가

## 설계 원칙

**틀린 답을 조용히 내놓지 않습니다.** 이 도구의 유일한 존재 이유는 정확히 아는 것이고, 잘못된 "문제 없음"은 도구가 없는 것보다 나쁩니다 — 사용자가 그 답을 믿고 수술 대상을 잘못 고르기 때문입니다.

같은 파일에 중복 레코드 처리 정책만 바꿔 세 번 색인한 결과가 세 가지로 갈렸고, 그중 하나는 끊긴 노드가 있는데도 `orphans: 0`을 보고했습니다. 이 관측이 설계 전반을 규정합니다 ([ADR-0004](docs/adr/ADR-0004-schema-drift-defense.md)).

- 읽기·시각화는 웹, 파일 수정은 CLI ([ADR-0003](docs/adr/ADR-0003-cli-writes-web-reads.md))
- 수술은 레코드 삭제 없이 `parentUuid` 재연결만 ([ADR-0002](docs/adr/ADR-0002-record-preserving-reattach.md))
- 인덱서·CLI·웹이 단일 언어, 단일 파싱 구현 ([ADR-0001](docs/adr/ADR-0001-typescript-single-language.md))

## 예정 명령

```
sessgraph inspect <file>     # 조각·root·orphan 리포트
sessgraph serve <file>       # 읽기 전용 웹 뷰어
sessgraph reattach <file> --uuid X --parent Y --reason "..."
sessgraph verify <file>      # leaf → root 역추적 길이
sessgraph revert <file>      # 백업 복원
sessgraph schema             # 명령·플래그·오류 코드를 기계 판독 형태로 출력
```

`schema`를 뺀 모든 명령은 `--json`으로 기계 판독 출력을 낼 수 있습니다 ([규약](docs/spec/20260903-1218-machine-readable-output.spec.md)). `schema`는 항상 기계 판독입니다.

## ⚠️ 주의

- 이 도구가 읽는 필드는 [공식 문서가 "internal, changes between versions"로 명시](https://code.claude.com/docs/en/sessions.md)한 비공개 스키마입니다. 전부 리버스엔지니어링 결과이며 Claude Code 업데이트로 깨질 수 있습니다.
- 세션 파일에는 자격증명·경로·개인정보가 그대로 들어 있습니다. **이 리포에 실제 세션 파일을 커밋하지 마세요.** 테스트 픽스처는 구조 필드만 남긴 익명화본을 씁니다.
- 세션 파일 수정은 되돌리기 어려운 작업입니다. 이 도구는 항상 백업을 만들지만, 중요한 세션은 별도로 보관하세요.

## 문서

- [CLAUDE.md](CLAUDE.md) — 현재 운영 규칙
- [docs/README.md](docs/README.md) — 문서 거버넌스 체계
- [docs/adr/](docs/adr/) — 기술 결정 기록

## License

MIT
