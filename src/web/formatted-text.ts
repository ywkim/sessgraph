/**
 * 대화 글의 서식 보기. 해석은 marked의 토큰 분해에 맡기고, 출력은 아래 허용
 * 목록의 요소만 직접 만든다 — `innerHTML`을 쓰지 않는다
 * (docs/adr/ADR-0009-markdown-view-marked-lexer.md,
 * docs/spec/20260907-1500-node-body-full-text.spec.md "서식 보기").
 */
import { Lexer, type Token, type Tokens } from "marked";

/** 만들 수 있는 요소의 허용 목록 */
export const ALLOWED_TAGS = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "em",
  "strong",
  "del",
  "hr",
  "br",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "a",
] as const;
export type AllowedTag = (typeof ALLOWED_TAGS)[number];

/** 만들 수 있는 속성의 허용 목록 */
export const ALLOWED_ATTRS = [
  "href",
  "target",
  "rel",
  "style",
  "class",
] as const;
export type AllowedAttr = (typeof ALLOWED_ATTRS)[number];

export type FNode =
  | { readonly text: string }
  | {
      readonly tag: AllowedTag;
      readonly attrs?: Partial<Record<AllowedAttr, string>>;
      readonly children: readonly FNode[];
    };

const text = (value: string): FNode => ({ text: value });
const el = (
  tag: AllowedTag,
  children: readonly FNode[],
  attrs?: Partial<Record<AllowedAttr, string>>,
): FNode => (attrs ? { tag, attrs, children } : { tag, children });

/** 서식 기호가 든 글을 허용 목록의 트리로 만든다. 순수 함수. 해석에 실패하면 던진다. */
export function formatToTree(source: string): FNode[] {
  return blocks(Lexer.lex(source));
}

function blocks(tokens: readonly Token[]): FNode[] {
  const out: FNode[] = [];
  for (const token of tokens) {
    if (token.type === "text") {
      // 블록 수준 text(목록 항목 안 등)는 문단으로 감싸지 않고 인라인으로 푼다
      const t = token as Tokens.Text;
      out.push(...(t.tokens ? inlines(t.tokens) : [text(t.text)]));
      continue;
    }
    const node = block(token);
    if (node) out.push(node);
  }
  return out;
}

function block(token: Token): FNode | null {
  switch (token.type) {
    case "space":
    case "def":
      return null;
    case "heading": {
      const t = token as Tokens.Heading;
      const depth = Math.min(Math.max(t.depth, 1), 6);
      return el(`h${depth}` as AllowedTag, inlines(t.tokens));
    }
    case "paragraph":
      return el("p", inlines((token as Tokens.Paragraph).tokens));
    case "blockquote":
      return el("blockquote", blocks((token as Tokens.Blockquote).tokens));
    case "code": {
      const t = token as Tokens.Code;
      const lang = t.lang?.split(/\s+/)[0] ?? "";
      const attrs = /^[\w+#.-]{1,40}$/.test(lang)
        ? { class: `language-${lang}` }
        : undefined;
      return el("pre", [el("code", [text(t.text)], attrs)]);
    }
    case "hr":
      return el("hr", []);
    case "list": {
      const t = token as Tokens.List;
      return el(
        t.ordered ? "ol" : "ul",
        t.items.map((item) => listItem(item)),
      );
    }
    case "table": {
      const t = token as Tokens.Table;
      const cell = (c: Tokens.TableCell, tag: "th" | "td"): FNode =>
        el(
          tag,
          inlines(c.tokens),
          c.align ? { style: `text-align: ${c.align}` } : undefined,
        );
      return el("table", [
        el("thead", [
          el(
            "tr",
            t.header.map((c) => cell(c, "th")),
          ),
        ]),
        el(
          "tbody",
          t.rows.map((row) =>
            el(
              "tr",
              row.map((c) => cell(c, "td")),
            ),
          ),
        ),
      ]);
    }
    case "html":
      // 글에 든 HTML은 요소로 만들지 않고 글자 그대로 보인다
      return el("pre", [text((token as Tokens.HTML).text)]);
    default:
      // 모르는 토큰은 사라지지 않고 글자로 보인다
      return el("p", [text(token.raw)]);
  }
}

function listItem(item: Tokens.ListItem): FNode {
  const children = blocks(item.tokens);
  if (item.task) {
    children.unshift(text(item.checked ? "[x] " : "[ ] "));
  }
  return el("li", children);
}

function inlines(tokens: readonly Token[] | undefined): FNode[] {
  if (!tokens) return [];
  const out: FNode[] = [];
  for (const token of tokens) {
    if (token.type === "text") {
      const t = token as Tokens.Text;
      out.push(...(t.tokens ? inlines(t.tokens) : [text(t.text)]));
    } else {
      out.push(inline(token));
    }
  }
  return out;
}

function inline(token: Token): FNode {
  switch (token.type) {
    case "escape":
      return text((token as Tokens.Escape).text);
    case "strong":
      return el("strong", inlines((token as Tokens.Strong).tokens));
    case "em":
      return el("em", inlines((token as Tokens.Em).tokens));
    case "del":
      return el("del", inlines((token as Tokens.Del).tokens));
    case "codespan":
      return el("code", [text((token as Tokens.Codespan).text)]);
    case "br":
      return el("br", []);
    case "link": {
      const t = token as Tokens.Link;
      if (!isSafeHref(t.href)) return text(t.raw);
      return el("a", inlines(t.tokens), {
        href: t.href,
        target: "_blank",
        rel: "noopener noreferrer",
      });
    }
    case "image":
      // 그림은 요소로 만들지 않는다 — 화면이 글 안의 주소로 요청을 보내지 않는다
      return text(token.raw);
    case "html":
      return text((token as Tokens.Tag).text);
    default:
      return text(token.raw);
  }
}

/** `http:`, `https:`, `mailto:`만 링크로 만든다. 공백·제어 문자가 든 주소는 거부한다. */
export function isSafeHref(href: string): boolean {
  if (/[\s\u0000-\u001f\u007f]/.test(href)) return false;
  return /^(https?:\/\/|mailto:)/i.test(href);
}

/** 트리를 DOM 조각으로 만든다. 요소와 속성은 허용 목록만 지나간다. */
export function renderFormatted(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const node of formatToTree(source)) fragment.append(build(node));
  return fragment;
}

function build(node: FNode): Node {
  if ("text" in node) return document.createTextNode(node.text);
  const element = document.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs ?? {})) {
    element.setAttribute(name, value);
  }
  for (const child of node.children) element.append(build(child));
  return element;
}
