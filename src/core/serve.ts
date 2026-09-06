import type { IndexResult, NodeIndex, SegmentDetail } from "./types.js";
import { resolveSegmentOrigins } from "./segment-origin.js";

/**
 * 한 세그먼트의 노드 목록과 화면에 표시할 재연결 명령어를 계산한다.
 * 파일을 읽지 않는 순수 함수다 — 본문을 `byteOffset`으로 seek해 읽는 것은
 * 서버 계층(`src/cli/serve.ts`)의 일이다
 * (docs/spec/20260902-0420-serve-command.spec.md "데이터 모델").
 *
 * Spec은 시그니처를 `buildSegmentDetail(index, rootUuid)`로 적었지만
 * `IndexResult`는 세그먼트의 root/leaf만 노출하고 그 사이 노드는 담지
 * 않는다. 노드 목록을 만들려면 uuid→NodeIndex 조회 테이블이 필요하므로
 * `nodes`를, 명령어 문자열에 세션 파일 경로가 들어가므로 `filePath`를
 * 추가 인자로 받는다 — `reattach`/`revert`가 같은 이유로 Spec 시그니처를
 * 보완한 것과 동일한 처리다.
 *
 * `rootUuid`가 어떤 세그먼트의 root도 아니면 `null`을 반환한다
 * (서버가 404로 옮긴다).
 */
export function buildSegmentDetail(
  index: IndexResult,
  nodes: ReadonlyMap<string, NodeIndex>,
  filePath: string,
  rootUuid: string,
): SegmentDetail | null {
  const segmentIndex = index.segments.findIndex((s) => s.rootUuid === rootUuid);
  if (segmentIndex === -1) return null;
  const segment = index.segments[segmentIndex]!;

  const childrenByParent = new Map<string, NodeIndex[]>();
  for (const node of nodes.values()) {
    if (node.parentUuid === null) continue;
    if (!nodes.has(node.parentUuid)) continue; // orphan — 세그먼트에 속하지 않는다
    const siblings = childrenByParent.get(node.parentUuid);
    if (siblings) siblings.push(node);
    else childrenByParent.set(node.parentUuid, [node]);
  }

  const root = nodes.get(rootUuid);
  const collected: NodeIndex[] = [];
  if (root) {
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop()!;
      collected.push(current);
      const kids = childrenByParent.get(current.uuid);
      if (kids) stack.push(...kids);
    }
    // root → leaf 순서. 파일 출현 순서가 곧 시간 순서다 (`buildIndex`가
    // 세그먼트 leaf를 고를 때 쓰는 기준과 같은 정렬을 쓴다).
    collected.sort((a, b) => a.lineNo - b.lineNo);
  }

  // origins를 조각 하나만 위해 다시 계산한다 — 목록(`/api/session/:id/index`)과
  // 같은 규칙을 두 곳에서 따로 구현하지 않기 위해서다
  // (docs/design/20260906-2000-segment-origin-backlink.tdd.md "이을 지점 계산은 한 곳에만 둔다").
  const origin = resolveSegmentOrigins(index, nodes)[segmentIndex]!;

  if (origin.kind !== "recorded" && origin.kind !== "inferred") {
    // start/unresolved/missing — 기록된 uuid가 파일에 없는 경우를 포함해
    // 채울 값이 없거나 확인 없이 단정할 수 없으므로 제안하지 않는다
    // (Spec "SegmentDetail의 기존 동작 변경").
    return {
      segment,
      nodes: collected,
      suggestedReattachCommand: null,
      suggestedParentSource: null,
    };
  }

  // `--reason`은 사용자가 채워야 하므로 빈 자리로 둔다 (Spec "데이터 모델").
  const command = `sessgraph reattach ${filePath} --uuid ${segment.rootUuid} --parent ${origin.parentUuid} --reason ""`;

  return {
    segment,
    nodes: collected,
    suggestedReattachCommand: command,
    suggestedParentSource: origin.kind,
  };
}
