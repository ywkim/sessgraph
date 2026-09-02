# 골든 픽스처

`buildIndex()` 구현보다 **먼저** 작성한 기대 출력이다 (`src/core/CLAUDE.md` "테스트"). 구현 결과에 맞춰 여기 수치를 고치지 않는다 — 수치가 틀렸다고 판단되면 왜 틀렸는지를 먼저 적고 고친다.

전부 손으로 계산한 합성 데이터다. 실제 세션에서 추출한 것이 아니므로 본문·경로·자격증명이 들어 있지 않다 (루트 CLAUDE.md "픽스처 정책").

| 픽스처                         | 무엇을 못박는가                                     |
| ------------------------------ | --------------------------------------------------- |
| `minimal-chain.anon.jsonl`     | 끊긴 곳 없는 단일 체인                              |
| `compact-split.anon.jsonl`     | compact_boundary 분할 + uuid 없는 메타데이터 레코드 |
| `duplicate-parents.anon.jsonl` | 중복 uuid에서 정책별로 답이 갈리는 것 (ADR-0004)    |
| `orphan.anon.jsonl`            | 존재하지 않는 부모를 가리키는 노드                  |
| `malformed-line.anon.jsonl`    | 깨진 줄을 건너뛰되 보고하는 것                      |
| `no-parent-field.anon.jsonl`   | 스키마 소실 시 0이 아니라 throw                     |
| `empty.anon.jsonl`             | 0바이트는 불변식 위반이 아님                        |

## 기대값에 넣지 않은 것

- **`durationMs`** — 실행마다 달라진다. 성능은 골든 값이 아니라 Spec의 "성능 요구사항" 상한으로 검증한다
- **`byteOffset` / `byteLength`** — 줄마다 손으로 세면 오히려 오답 위험이 크다. 대신 불변식으로 검증한다: 각 노드에 대해 파일의 `[byteOffset, byteOffset + byteLength)` 구간을 잘라 JSON으로 파싱했을 때 그 `uuid`가 노드의 `uuid`와 같아야 한다

## 아직 명세에 없어 픽스처가 대신 드러내는 것

- **`DuplicatePolicy` 기본값** — `inspect` Spec은 "데이터 모델에서 정의하는 기본값"을 따르라고 하는데, 그 기본값이 어디에도 없다. `duplicate-parents.expected.json`은 임의로 하나를 고르는 대신 세 정책의 결과를 모두 못박아 둔다. 기본값이 정해지면 그 정책을 가리키는 항목을 추가한다
- **`parentUuid: null`과 키 자체의 부재를 구분하는가** — `no-parent-field.anon.jsonl`은 키를 통째로 뺐으므로 두 해석이 같은 답을 낸다. 구분이 필요해지면 픽스처를 하나 더 만든다
