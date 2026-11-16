import { test } from "node:test";
import assert from "node:assert/strict";
import type { VNode } from "preact";
import { SearchForm, type SearchFormProps } from "./search-form.js";
import { initialSearchForm, withTier } from "./search-form-state.js";

/** vnode 트리에서 조건에 맞는 요소를 모두 모은다. DOM 없이 구조와 핸들러를 확인한다. */
function findAll(node: unknown, match: (v: VNode) => boolean): VNode[] {
  if (Array.isArray(node)) return node.flatMap((n) => findAll(n, match));
  if (node === null || typeof node !== "object") return [];
  const vnode = node as VNode<{ children?: unknown }>;
  const here = match(vnode) ? [vnode] : [];
  return [...here, ...findAll(vnode.props.children, match)];
}

function setup(overrides: Partial<SearchFormProps> = {}) {
  const calls: unknown[][] = [];
  const props: SearchFormProps = {
    state: initialSearchForm(),
    onQuery: (q) => calls.push(["query", q]),
    onTier: (t, on) => calls.push(["tier", t, on]),
    onPeriod: (p) => calls.push(["period", p]),
    onSubmit: () => calls.push(["submit"]),
    ...overrides,
  };
  return { tree: SearchForm(props), calls };
}

type InputProps = {
  name?: string;
  value?: string;
  checked?: boolean;
  onChange?: (e: unknown) => void;
  onInput?: (e: unknown) => void;
};

test("종류 체크박스 셋이 순서대로 있고 상태대로 체크된다", () => {
  const state = withTier(initialSearchForm(), "meta", true);
  const { tree } = setup({ state });
  const boxes = findAll(tree, (v) => (v.props as InputProps).name === "tier");
  assert.deepEqual(
    boxes.map((b) => [
      (b.props as InputProps).value,
      (b.props as InputProps).checked,
    ]),
    [
      ["conversation", true],
      ["tool", false],
      ["meta", true],
    ],
  );
});

test("기간 선택지는 PERIODS 순서로 나온다", () => {
  const { tree } = setup();
  const options = findAll(tree, (v) => v.type === "option");
  assert.deepEqual(
    options.map((o) => (o.props as InputProps).value),
    ["all", "7d", "30d", "90d"],
  );
});

test("체크박스를 바꾸면 그 종류와 켜짐 여부로 onTier가 불린다", () => {
  const { tree, calls } = setup();
  const [, tool] = findAll(
    tree,
    (v) => (v.props as InputProps).name === "tier",
  );
  (tool!.props as InputProps).onChange!({ currentTarget: { checked: true } });
  assert.deepEqual(calls, [["tier", "tool", true]]);
});

test("기간 선택은 onPeriod, 검색어 입력은 onQuery로 전달된다", () => {
  const { tree, calls } = setup();
  const [select] = findAll(tree, (v) => v.type === "select");
  (select!.props as InputProps).onChange!({ currentTarget: { value: "30d" } });
  const [input] = findAll(tree, (v) => (v.props as InputProps).name === "q");
  (input!.props as InputProps).onInput!({ currentTarget: { value: "대기열" } });
  assert.deepEqual(calls, [
    ["period", "30d"],
    ["query", "대기열"],
  ]);
});

test("제출은 기본 동작(페이지 이동)을 막고 onSubmit을 부른다", () => {
  const { tree, calls } = setup();
  const [form] = findAll(tree, (v) => v.type === "form");
  let prevented = false;
  (form!.props as unknown as { onSubmit: (e: unknown) => void }).onSubmit({
    preventDefault: () => (prevented = true),
  });
  assert.equal(prevented, true);
  assert.deepEqual(calls, [["submit"]]);
});
