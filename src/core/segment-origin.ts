import { COMPACT_BOUNDARY } from "./types.js";
import type { IndexResult, NodeIndex, SegmentOrigin } from "./types.js";
import { tryFindSegmentForUuid } from "./segment.js";

/**
 * 조각마다 "어디서 이어져 오는가"를 해소한다. 파일을 읽지 않고 이미 만들어진
 * 인덱스만 보는 순수 함수다. `index.segments`와 같은 길이·같은 순서로 돌려준다
 * (docs/spec/20260906-2000-segment-origin-backlink.spec.md "불변식").
 *
 * `buildSegmentDetail`(`src/core/serve.ts`)이 같은 규칙을 다시 계산하지 않고
 * 이 함수의 결과를 소비한다 — 목록 화면과 펼친 화면이 서로 다른 부모를
 * 가리키는 것을 구조적으로 막기 위해서다
 * (docs/design/20260906-2000-segment-origin-backlink.tdd.md "이을 지점 계산은 한 곳에만 둔다").
 */
export function resolveSegmentOrigins(
  index: IndexResult,
  nodes: ReadonlyMap<string, NodeIndex>,
): readonly SegmentOrigin[] {
  return index.segments.map((segment, i): SegmentOrigin => {
    if (segment.rootSubtype !== COMPACT_BOUNDARY) {
      return { kind: "start" };
    }

    const recorded = segment.rootLogicalParentUuid;
    if (recorded !== null) {
      if (!nodes.has(recorded)) {
        return { kind: "missing", parentUuid: recorded };
      }
      const parentSegment = tryFindSegmentForUuid(index, nodes, recorded);
      return {
        kind: "recorded",
        parentUuid: recorded,
        parentSegmentRootUuid: parentSegment?.rootUuid ?? null,
      };
    }

    const previous = index.segments[i - 1];
    if (!previous) {
      return { kind: "unresolved" };
    }
    // previous.leafUuid는 인덱스가 만든 값이라 항상 nodes에 있다 — missing이
    // 성립하지 않는다 (Spec "불변식").
    const parentSegment = tryFindSegmentForUuid(
      index,
      nodes,
      previous.leafUuid,
    );
    return {
      kind: "inferred",
      parentUuid: previous.leafUuid,
      parentSegmentRootUuid: parentSegment?.rootUuid ?? null,
    };
  });
}
