import { tryFindSegmentForUuid } from "./segment.js";
import type { IndexResult, MatchAttribution, NodeIndex } from "./types.js";

/**
 * 색인 행의 uuid를 세션 인덱스의 조각에 귀속시킨다. 순수 함수
 * (docs/spec/20261015-1821-search-index.spec.md "귀속").
 */
export function attributeOne(
  index: IndexResult,
  nodes: ReadonlyMap<string, NodeIndex>,
  uuid: string | null,
): MatchAttribution {
  if (uuid === null) return { kind: "none" };
  const node = nodes.get(uuid);
  if (!node) return { kind: "unindexed", uuid };
  const segment = tryFindSegmentForUuid(index, nodes, uuid);
  if (segment) {
    return {
      kind: "segment",
      uuid,
      segmentRootUuid: segment.rootUuid,
      lineNo: node.lineNo,
    };
  }
  return { kind: "orphan", uuid, lineNo: node.lineNo };
}
