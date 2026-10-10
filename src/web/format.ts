// DOM에 의존하지 않는 순수 함수만 모은다 — node:test로 직접 단위 테스트할 수
// 있다 (jsdom 등 추가 의존성 없이). DOM을 만지는 렌더링 코드는 app.ts에 남긴다.

/**
 * 본문 한 줄에서 사람이 읽을 부분만 뽑는다. 그래프 구조를 다시 계산하지는
 * 않는다 — 여기서 파싱하는 것은 표시용 텍스트뿐이다.
 */
export function summarizeRaw(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const content = (parsed as { message?: { content?: unknown } })?.message
    ?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as { type?: string; text?: string; name?: string }[])
      .map((part) => {
        if (part?.type === "text") return part.text ?? "";
        if (part?.type === "tool_use") return `[도구 ${part.name}]`;
        if (part?.type === "tool_result") return "[도구 결과]";
        return `[${part?.type ?? "?"}]`;
      })
      .join(" ");
  }
  return raw;
}

export function formatTime(timestamp: string | null): string {
  if (!timestamp) return "";
  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) {
      return timestamp;
    }
    // 브라우저 로컬 시간대로 변환해 "YYYY-MM-DD HH:MM:SS" 포맷으로 표시한다
    // (docs/design/20260904-1600-timezone-display.tdd.md)
    const formatter = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    const hour = parts.find((p) => p.type === "hour")?.value;
    const minute = parts.find((p) => p.type === "minute")?.value;
    const second = parts.find((p) => p.type === "second")?.value;
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  } catch {
    return timestamp;
  }
}

/** 최근 세션이 앞. 시각을 모르는 세션(null·해석 불가)은 맨 뒤에 입력 순서대로 둔다. */
export function sortByRecency<T extends { firstTimestamp: string | null }>(
  sessions: readonly T[],
): T[] {
  const time = (s: T): number => {
    const t = s.firstTimestamp ? Date.parse(s.firstTimestamp) : NaN;
    return Number.isNaN(t) ? -Infinity : t;
  };
  return sessions
    .map((s, i) => ({ s, i, t: time(s) }))
    .sort((a, b) => (a.t === b.t ? a.i - b.i : b.t - a.t))
    .map(({ s }) => s);
}

/**
 * 목록 항목 2줄째 문구. 1줄째가 라벨(제목 없음)이면 라벨을 반복하지 않는다.
 * 실패한 세션은 시각 대신 호출자가 사유를 보여주므로 시각 부분을 넣지 않는다.
 */
export function sessionSubline(s: {
  label: string;
  title: string | null;
  titleSource: "custom-title" | "ai-title" | "first-user-message" | null;
  firstTimestamp: string | null;
  status: "unread" | "ready" | "failed";
}): string {
  const parts: string[] = [];
  if (s.title !== null) parts.push(s.label);
  if (s.status !== "failed") {
    parts.push(s.firstTimestamp ? formatTime(s.firstTimestamp) : "시각 없음");
  }
  if (s.titleSource === "first-user-message") parts.push("첫 메시지");
  return parts.join(" · ");
}

/** 리터럴 부분 문자열 비교(대소문자 무시) — 정규식으로 해석하지 않는다. */
export function matchesQuery(label: string, query: string): boolean {
  return label.toLowerCase().includes(query.toLowerCase());
}

export function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      (
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }) as Record<string, string>
      )[c]!,
  );
}
