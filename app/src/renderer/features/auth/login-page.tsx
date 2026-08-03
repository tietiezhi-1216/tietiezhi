import { useState } from "react";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type LoginView = "choices" | "api_key" | "browser";

interface LoginPageProps {
  onAuthenticated: () => void;
  onOpenBrowserLogin: () => Promise<void>;
  onCancelBrowserLogin: () => Promise<void>;
  onLoginWithAPIKey: (apiKey: string) => Promise<void>;
  onOpenRegistration: () => Promise<void>;
}

export function LoginPage({
  onAuthenticated,
  onOpenBrowserLogin,
  onCancelBrowserLogin,
  onLoginWithAPIKey,
  onOpenRegistration,
}: LoginPageProps) {
  const [view, setView] = useState<LoginView>("choices");
  const [apiKey, setAPIKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const beginBrowserLogin = async () => {
    setBusy(true);
    setError("");
    setView("browser");
    try {
      await onOpenBrowserLogin();
      onAuthenticated();
    } catch (cause) {
      setView("choices");
      if (!(cause instanceof Error && cause.message === "登录已取消")) {
        setError(cause instanceof Error ? cause.message : "无法完成浏览器登录");
      }
    } finally {
      setBusy(false);
    }
  };

  const submitAPIKey = async () => {
    if (!apiKey.trim()) {
      setError("请输入 API 密钥");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onLoginWithAPIKey(apiKey);
      onAuthenticated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "API 密钥登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="bg-background relative grid h-full min-h-0 place-items-center overflow-hidden px-6">
      <div className="absolute inset-x-0 top-0 h-14 [-webkit-app-region:drag]" />

      <section className="flex w-full max-w-[400px] -translate-y-3 flex-col items-center text-center">
        <div className="relative mb-5 size-16" role="img" aria-label="Tietiezhi 章鱼">
          <img
            src="/octopus-loader/base-open.png"
            alt=""
            className="absolute inset-0 size-full object-contain"
          />
          <img
            src="/octopus-loader/base-closed.png"
            alt=""
            className="animate-octopus-blink absolute inset-0 size-full object-contain opacity-0 motion-reduce:animate-none"
          />
        </div>

        {view === "choices" && (
          <>
            <h1 className="mb-8 text-[28px] leading-none font-medium tracking-[-0.025em]">
              登录 Tietiezhi
            </h1>
            <div className="flex w-full max-w-[340px] flex-col gap-3">
              <Button
                type="button"
                size="lg"
                className="h-12 w-full rounded-full text-sm shadow-none"
                disabled={busy}
                onClick={() => void beginBrowserLogin()}
              >
                {busy && <LoaderCircle className="animate-spin" />}
                登录铁铁汁
              </Button>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-12 w-full rounded-full bg-transparent text-sm shadow-none"
                disabled={busy}
                onClick={() => {
                  setView("api_key");
                  setError("");
                }}
              >
                使用其他方式登录
              </Button>
            </div>
            <div className="w-full max-w-[340px]">
              <Button
                type="button"
                variant="link"
                className="text-muted-foreground mt-3 h-8 px-3 text-sm font-normal"
                onClick={() => void onOpenRegistration()}
              >
                注册
              </Button>
            </div>
          </>
        )}

        {view === "api_key" && (
          <form
            className="flex w-full flex-col text-left"
            onSubmit={(event) => {
              event.preventDefault();
              void submitAPIKey();
            }}
          >
            <h1 className="text-center text-[28px] leading-none font-medium tracking-[-0.025em]">
              登录 Tietiezhi
            </h1>
            <label htmlFor="gateway-api-key" className="mt-8 text-sm font-medium">
              Tietiezhi Gateway API 密钥
            </label>
            <Input
              id="gateway-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => {
                setAPIKey(event.target.value);
                setError("");
              }}
              placeholder="sk-tietiezhi-..."
              className="mt-2 h-11 rounded-xl border bg-muted px-4 text-sm"
              autoFocus
            />
            {error && <p className="text-destructive mt-2 px-1 text-xs">{error}</p>}
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Button
                type="button"
                variant="secondary"
                className="h-10 rounded-full"
                disabled={busy}
                onClick={() => {
                  setView("choices");
                  setError("");
                }}
              >
                取消
              </Button>
              <Button type="submit" className="h-10 rounded-full" disabled={busy}>
                {busy && <LoaderCircle className="animate-spin" />}
                继续
              </Button>
            </div>
          </form>
        )}

        {view === "browser" && (
          <>
            <p className="text-muted-foreground mt-4 text-sm">请继续在浏览器中登录</p>
            {error && <p className="text-destructive mt-2 text-xs">{error}</p>}
            <div className="w-full max-w-[340px]">
              <Button
                type="button"
                variant="outline"
                className="mt-7 h-11 w-full rounded-full bg-transparent"
                onClick={() => {
                  void onCancelBrowserLogin();
                  setView("choices");
                  setError("");
                }}
              >
                取消登录
              </Button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
