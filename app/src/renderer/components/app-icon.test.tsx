// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppIcon } from "./app-icon";

describe("AppIcon", () => {
  it("从本地 Iconify 数据渲染图标", () => {
    const { container } = render(<AppIcon name="arrow-left" />);
    const svg = container.querySelector("svg");

    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });
});
