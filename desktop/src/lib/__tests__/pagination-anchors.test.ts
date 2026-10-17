import { describe, expect, it } from "vitest";
import {
  findPageTransitionIndices,
  normalizeAnchorText,
} from "../pagination-anchors";

/** Cumulative normalized offsets of each part inside the joined lane. */
function offsetsOf(...parts: string[]): number[] {
  const normalized = parts.map((part) => normalizeAnchorText(part));
  const offsets: number[] = [];
  let cumulative = 0;
  for (const part of normalized) {
    offsets.push(cumulative);
    cumulative += part.length;
  }
  return offsets;
}

describe("findPageTransitionIndices", () => {
  it("returns nothing for a single page", () => {
    const lane = "one page of resume content only";
    expect(findPageTransitionIndices(lane, [lane])).toEqual([]);
  });

  it("returns nothing when the lane has no gram-length content", () => {
    expect(findPageTransitionIndices("短", ["短", "短"])).toEqual([]);
  });

  it("returns nothing when there are no page texts", () => {
    expect(findPageTransitionIndices("some resume content here", [])).toEqual([]);
  });

  it("anchors clean multi-page splits at the exact page joints", () => {
    const page1 =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    const page2 = "nova orion pegasus quasar raven sirius taurus ursa vega";
    const page3 = "yarrow zinnia crocus dahlia edelweiss freesia gardenia hibiscus";
    const lane = normalizeAnchorText(page1 + page2 + page3);
    const [, page2Start, page3Start] = offsetsOf(page1, page2, page3);

    expect(findPageTransitionIndices(lane, [page1, page2, page3])).toEqual([
      { page: 2, charIndex: page2Start },
      { page: 3, charIndex: page3Start },
    ]);
  });

  it("ignores whitespace and zero-width characters on both sides", () => {
    const page1 = "alpha beta gamma delta epsilon zeta eta theta";
    const page2 = "nova orion pegasus quasar raven sirius taurus";
    const noisyLane = `  ${page1}  \n\u200b  ${page2}\u200d  `;
    const [, page2Start] = offsetsOf(page1, page2);
    const result = findPageTransitionIndices(noisyLane, [page1, page2]);
    expect(result).toHaveLength(1);
    expect(result[0]?.page).toBe(2);
    expect(result[0]?.charIndex).toBe(page2Start);
  });

  it("backtracks a repeated page-start phrase to the phrase start", () => {
    const page1 = "个人简介 负责简历编辑器分页预览功能的设计与实现并完成验证";
    const phrase = "高级工程师 2020 - 2023";
    const page2 = `${phrase} 协作平台 团队性能 交付优化 用户上线 系统测试`;
    const page3 = `${phrase} 维护平台 团队性能 部署测试 提升数据 项目设计`;
    const lane = normalizeAnchorText(page1 + page2 + page3);
    const [, page2Start, page3Start] = offsetsOf(page1, page2, page3);

    expect(findPageTransitionIndices(lane, [page1, page2, page3])).toEqual([
      { page: 2, charIndex: page2Start },
      { page: 3, charIndex: page3Start },
    ]);
  });

  it("keeps transitions monotonic with a small shared vocabulary", () => {
    const vocab = "负责 系统 设计 开发 优化 性能 提升 团队 协作 平台 架构";
    const page1 = `P1X ${vocab} P1Y ${vocab} P1Z ${vocab}`;
    const page2 = `P2X ${vocab} P2Y ${vocab} P2Z ${vocab}`;
    const page3 = `P3X ${vocab} P3Y ${vocab} P3Z ${vocab}`;
    const lane = normalizeAnchorText(page1 + page2 + page3);
    const [, page2Start, page3Start] = offsetsOf(page1, page2, page3);

    const transitions = findPageTransitionIndices(lane, [page1, page2, page3]);
    expect(transitions.map((transition) => transition.page)).toEqual([2, 3]);
    expect(transitions[0]?.charIndex).toBe(page2Start);
    expect(transitions[1]?.charIndex).toBe(page3Start);
  });

  it("omits boundaries instead of guessing when a page is unanchorable", () => {
    const page1 = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const page2 = "this content is completely absent from the lane itself";
    const page3 = "yarrow zinnia crocus dahlia edelweiss freesia gardenia";
    const lane = normalizeAnchorText(page1 + page3);

    expect(findPageTransitionIndices(lane, [page1, page2, page3])).toEqual([]);
  });

  it("does not mis-anchor when the lane repeats identical content", () => {
    const block = "identical resume block content repeated over and over";
    const lane = normalizeAnchorText(block + block);
    const result = findPageTransitionIndices(lane, [block, block]);

    // Both halves match both pages' gram sets, so no unambiguous transition
    // exists; the algorithm must not fabricate a boundary.
    expect(result).toEqual([]);
  });
});
