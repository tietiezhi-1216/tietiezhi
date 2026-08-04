// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LoginPage } from "./login-page";

function renderLogin(overrides?: {
  onAuthenticated?: () => void;
  onOpenBrowserLogin?: () => Promise<void>;
  onCancelBrowserLogin?: () => Promise<void>;
  onLoginWithAPIKey?: (apiKey: string) => Promise<void>;
  onOpenRegistration?: () => Promise<void>;
}) {
  return render(
    <LoginPage
      onAuthenticated={overrides?.onAuthenticated ?? (() => undefined)}
      onOpenBrowserLogin={overrides?.onOpenBrowserLogin ?? (() => Promise.resolve())}
      onCancelBrowserLogin={overrides?.onCancelBrowserLogin ?? (() => Promise.resolve())}
      onLoginWithAPIKey={overrides?.onLoginWithAPIKey ?? (() => Promise.resolve())}
      onOpenRegistration={overrides?.onOpenRegistration ?? (() => Promise.resolve())}
    />,
  );
}

describe("登录页", () => {
  it("默认提供铁铁汁登录、其他方式与注册入口", () => {
    renderLogin();

    expect(screen.getByRole("button", { name: "登录铁铁汁" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "使用其他方式登录" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "注册" })).toBeTruthy();
  });

  it("打开浏览器后进入等待状态", async () => {
    const onOpenBrowserLogin = vi.fn(() => new Promise<void>(() => undefined));
    renderLogin({ onOpenBrowserLogin });

    fireEvent.click(screen.getByRole("button", { name: "登录铁铁汁" }));

    expect(await screen.findByText("请继续在浏览器中登录")).toBeTruthy();
    expect(onOpenBrowserLogin).toHaveBeenCalledOnce();
  });

  it("浏览器登录失败后显示原因并允许重试", async () => {
    const onOpenBrowserLogin = vi.fn(() => Promise.reject(
      new Error("Error invoking remote method 'tietiezhi:invoke': Error: 无法打开默认浏览器"),
    ));
    renderLogin({ onOpenBrowserLogin });

    fireEvent.click(screen.getByRole("button", { name: "登录铁铁汁" }));

    expect((await screen.findByRole("alert")).textContent).toContain("无法打开默认浏览器");
    expect(screen.getByRole("alert").textContent).not.toContain("Error invoking remote method");
    expect((screen.getByRole("button", { name: "登录铁铁汁" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("API 密钥通过主进程验证后进入应用", async () => {
    const onAuthenticated = vi.fn();
    const onLoginWithAPIKey = vi.fn(() => Promise.resolve());
    renderLogin({ onAuthenticated, onLoginWithAPIKey });

    fireEvent.click(screen.getByRole("button", { name: "使用其他方式登录" }));
    fireEvent.change(screen.getByLabelText("Tietiezhi Gateway API 密钥"), {
      target: { value: "sk-tietiezhi-test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    expect(await screen.findByDisplayValue("sk-tietiezhi-test")).toBeTruthy();
    expect(onLoginWithAPIKey).toHaveBeenCalledWith("sk-tietiezhi-test");
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });

  it("API 密钥为空时停留在登录页", () => {
    renderLogin();

    fireEvent.click(screen.getByRole("button", { name: "使用其他方式登录" }));
    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    expect(screen.getByText("请输入 API 密钥")).toBeTruthy();
  });

  it("注册入口交给主进程打开", () => {
    const onOpenRegistration = vi.fn(() => Promise.resolve());
    renderLogin({ onOpenRegistration });

    fireEvent.click(screen.getByRole("button", { name: "注册" }));

    expect(onOpenRegistration).toHaveBeenCalledOnce();
  });
});
