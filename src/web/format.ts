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
    return raw.slice(0, 300);
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
      .join(" ")
      .slice(0, 300);
  }
  return raw.slice(0, 300);
}

export function formatTime(timestamp: string | null): string {
  if (!timestamp) return "";
  return timestamp.replace("T", " ").slice(0, 19);
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
