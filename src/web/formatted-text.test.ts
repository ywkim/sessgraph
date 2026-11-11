import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALLOWED_ATTRS,
  ALLOWED_TAGS,
  formatToTree,
  isSafeHref,
  type FNode,
} from "./formatted-text.js";

/** 트리를 모두 걸어 허용 목록 밖의 요소·속성이 없는지 확인하고, 요소 이름을 모은다. */
function collect(nodes: readonly FNode[], tags: string[] = []): string[] {
  for (const node of nodes) {
    if ("text" in node) continue;
    assert.ok(
      (ALLOWED_TAGS as readonly string[]).includes(node.tag),
      `허용 밖 요소 ${node.tag}`,
    );
    for (const name of Object.keys(node.attrs ?? {})) {
      assert.ok(
        (ALLOWED_ATTRS as readonly string[]).includes(name),
        `허용 밖 속성 ${name}`,
      );
    }
    tags.push(node.tag);
    collect(node.children, tags);
  }
  return tags;
}

function plain(nodes: readonly FNode[]): string {
  return nodes.map((n) => ("text" in n ? n.text : plain(n.children))).join("");
}

const tagsOf = (source: string) => collect(formatToTree(source));

describe("formatToTree", () => {
  it("제목·문단·목록·인용·코드·표·가로줄을 해석한다", () => {
    const tags = tagsOf(
      [
        "# 제목",
        "",
        "문단 **굵게** *기울임* ~~취소~~ `코드`",
        "",
        "- 가",
        "  - 나",
        "",
        "1. 하나",
        "",
        "> 인용",
        "",
        "```js",
        "const a = 1;",
        "```",
        "",
        "    들여쓴 코드",
        "",
        "| a | b |",
        "|:-|-:|",
        "| 1 | 2 |",
        "",
        "---",
      ].join("\n"),
    );
    for (const t of [
      "h1",
      "p",
      "strong",
      "em",
      "del",
      "code",
      "ul",
      "ol",
      "li",
      "blockquote",
      "pre",
      "table",
      "thead",
      "tbody",
      "th",
      "td",
      "hr",
    ]) {
      assert.ok(tags.includes(t), `${t}가 없다: ${tags.join(",")}`);
    }
  });

  it("표의 열 정렬은 text-align 스타일만 만든다", () => {
    const [table] = formatToTree("| a | b |\n|:-|-:|\n| 1 | 2 |");
    const styles: string[] = [];
    const walk = (n: FNode) => {
      if ("text" in n) return;
      if (n.attrs?.style) styles.push(n.attrs.style);
      n.children.forEach(walk);
    };
    walk(table!);
    assert.deepEqual(
      new Set(styles),
      new Set(["text-align: left", "text-align: right"]),
    );
  });

  it("코드의 언어 클래스는 안전한 이름일 때만 붙는다", () => {
    const find = (source: string) => {
      const [pre] = formatToTree(source);
      const code = (pre as Extract<FNode, { tag: string }>)
        .children[0] as Extract<FNode, { tag: string }>;
      return code.attrs?.class;
    };
    assert.equal(find("```ts\nx\n```"), "language-ts");
    assert.equal(find('```"><script>\nx\n```'), undefined);
  });

  it("글에 든 HTML은 요소가 되지 않고 글자로 남는다", () => {
    const source = [
      "<script>alert(1)</script>",
      "",
      '문단 <b onclick="x()">굵게</b> <img src=x onerror=alert(1)>',
      "",
      "<div>블록</div>",
    ].join("\n");
    const tree = formatToTree(source);
    const tags = collect(tree);
    for (const bad of ["script", "b", "img", "div"]) {
      assert.ok(!tags.includes(bad), bad);
    }
    const text = plain(tree);
    assert.match(text, /<script>alert\(1\)<\/script>/);
    assert.match(text, /onerror=alert\(1\)/);
  });

  it("그림은 img가 되지 않고 글자로 남는다", () => {
    const tree = formatToTree("![대체](http://example.com/x.png)");
    assert.ok(!collect(tree).includes("img"));
    assert.equal(plain(tree), "![대체](http://example.com/x.png)");
  });

  it("링크는 http·https·mailto만 a가 된다", () => {
    const anchors = (source: string) => {
      const out: Record<string, string | undefined>[] = [];
      const walk = (nodes: readonly FNode[]) => {
        for (const n of nodes) {
          if ("text" in n) continue;
          if (n.tag === "a") out.push({ ...n.attrs });
          walk(n.children);
        }
      };
      walk(formatToTree(source));
      return out;
    };
    assert.deepEqual(anchors("[a](https://e.com/x?y=1)"), [
      {
        href: "https://e.com/x?y=1",
        target: "_blank",
        rel: "noopener noreferrer",
      },
    ]);
    assert.equal(anchors("[a](mailto:x@e.com)").length, 1);
    for (const bad of [
      "[a](javascript:alert(1))",
      "[a](JaVaScRiPt:alert(1))",
      "[a](data:text/html,<script>alert(1)</script>)",
      "[a](/상대/경로)",
      "[a](vbscript:x)",
    ]) {
      assert.equal(anchors(bad).length, 0, bad);
    }
    // 거부된 링크도 글자는 남는다
    assert.match(
      plain(formatToTree("[a](javascript:alert(1))")),
      /javascript:alert\(1\)/,
    );
  });

  it("isSafeHref는 공백·제어 문자가 든 주소를 거부한다", () => {
    assert.equal(isSafeHref("https://e.com"), true);
    assert.equal(isSafeHref("http://e.com/a b"), false);
    assert.equal(isSafeHref("java\tscript:alert(1)"), false);
    assert.equal(isSafeHref("https://e.com/\u0000"), false);
    assert.equal(isSafeHref("//e.com"), false);
  });

  it("글자 `<`·`&`는 그대로 글자로 남는다", () => {
    assert.equal(plain(formatToTree("a < b & c")), "a < b & c");
  });

  it("서식 기호가 없는 글은 그 글자를 잃지 않는다", () => {
    const source = "그냥 문장입니다.\n둘째 줄.";
    assert.match(plain(formatToTree(source)), /그냥 문장입니다\./);
    assert.match(plain(formatToTree(source)), /둘째 줄\./);
  });

  it("목록 항목은 문단 없이 인라인으로 풀리고 중첩 목록은 유지된다", () => {
    const [ul] = formatToTree("- 가\n  - 나") as Extract<
      FNode,
      { tag: string }
    >[];
    assert.equal(ul!.tag, "ul");
    const li = ul!.children[0] as Extract<FNode, { tag: string }>;
    assert.equal(li.tag, "li");
    assert.equal(plain([li.children[0]!]), "가");
    assert.ok(collect(li.children).includes("ul"));
  });
});
