/**
 * 职责: 覆盖飞书卡片基础元素构建工具。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { describe, expect, it } from "vitest";

import { column, columnSet, divider, markdown, standardIcon } from "../src/feishu/card-builder.js";

describe("card-builder", () => {
  it("builds markdown with defaults", () => {
    expect(markdown("hello")).toEqual({
      tag: "markdown",
      content: "hello",
      text_align: "left",
      text_size: "normal_v2",
      margin: "0px 0px 0px 0px",
    });
  });

  it("builds markdown with icon and size", () => {
    expect(markdown("hello", { size: "notation", icon: { token: "info_outlined", color: "blue" } })).toEqual({
      tag: "markdown",
      content: "hello",
      text_align: "left",
      text_size: "notation",
      margin: "0px 0px 0px 0px",
      icon: {
        tag: "standard_icon",
        token: "info_outlined",
        color: "blue",
      },
    });
  });

  it("normalizes code fence language markers", () => {
    expect(markdown(["```sh", "npm test", "```"].join("\n"))).toEqual({
      tag: "markdown",
      content: ["```", "npm test", "```"].join("\n"),
      text_align: "left",
      text_size: "normal_v2",
      margin: "0px 0px 0px 0px",
    });
  });

  it("builds column set with defaults", () => {
    expect(columnSet([{ tag: "column" }])).toEqual({
      tag: "column_set",
      horizontal_spacing: "8px",
      horizontal_align: "left",
      columns: [{ tag: "column" }],
      margin: "0px 0px 0px 0px",
    });
  });

  it("builds auto-width column by default", () => {
    expect(column([{ tag: "markdown", content: "hello" }])).toEqual({
      tag: "column",
      width: "auto",
      elements: [{ tag: "markdown", content: "hello" }],
      padding: "8px 8px 8px 8px",
      direction: "vertical",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      horizontal_align: "left",
      vertical_align: "top",
      margin: "0px 0px 0px 0px",
    });
  });

  it("builds weighted column with background", () => {
    expect(column([{ tag: "markdown", content: "hello" }], { weight: 1, bg: "wathet-100" })).toEqual({
      tag: "column",
      width: "weighted",
      weight: 1,
      background_style: "wathet-100",
      elements: [{ tag: "markdown", content: "hello" }],
      padding: "8px 8px 8px 8px",
      direction: "vertical",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      horizontal_align: "left",
      vertical_align: "top",
      margin: "0px 0px 0px 0px",
    });
  });

  it("builds divider and standard icon", () => {
    expect(divider()).toEqual({ tag: "hr" });
    expect(standardIcon("info_outlined")).toEqual({
      tag: "standard_icon",
      token: "info_outlined",
      color: "grey",
    });
  });
});
