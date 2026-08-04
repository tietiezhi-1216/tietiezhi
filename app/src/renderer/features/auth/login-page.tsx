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

function loginErrorMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback;
  return cause.message
    .replace(/^Error invoking remote method 'tietiezhi:invoke':\s*/u, "")
    .replace(/^Error:\s*/u, "");
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
        setError(loginErrorMessage(cause, "无法完成浏览器登录"));
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
      setError(loginErrorMessage(cause, "API 密钥登录失败"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="relative grid h-full min-h-0 place-items-center overflow-hidden bg-white/84 px-6 text-slate-950 backdrop-blur-3xl dark:bg-slate-950/58 dark:text-slate-100">
      <div className="absolute inset-x-0 top-0 h-14 [-webkit-app-region:drag]" />
      <div className="pointer-events-none absolute -top-32 -left-24 size-80 rounded-full bg-sky-200/35 blur-3xl dark:bg-sky-950/45" />
      <div className="pointer-events-none absolute -right-28 -bottom-36 size-96 rounded-full bg-amber-100/45 blur-3xl dark:bg-indigo-950/45" />

      <section className="relative z-10 flex w-full max-w-[400px] -translate-y-3 flex-col items-center text-center [-webkit-app-region:no-drag]">
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
            <div className="flex w-full max-w-[288px] flex-col gap-2.5">
              <Button
                type="button"
                className="h-10 w-full rounded-full border-white/75 bg-white/92 text-sm text-slate-900 shadow-sm shadow-slate-400/10 hover:bg-white dark:border-white/30 dark:bg-slate-100/76 dark:text-slate-900 dark:shadow-black/20 dark:hover:bg-slate-100/88"
                disabled={busy}
                onClick={() => void beginBrowserLogin()}
              >
                {busy && <LoaderCircle className="animate-spin" />}
                登录铁铁汁
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-10 w-full rounded-full border-white/75 bg-white/72 text-sm text-slate-800 shadow-sm shadow-slate-400/5 hover:bg-white/88 hover:text-slate-900 dark:border-white/25 dark:bg-slate-800/52 dark:text-slate-100 dark:shadow-black/20 dark:hover:bg-slate-700/68 dark:hover:text-white"
                disabled={busy}
                onClick={() => {
                  setView("api_key");
                  setError("");
                }}
              >
                使用其他方式登录
              </Button>
            </div>
            <div className="w-full max-w-[288px]">
              <Button
                type="button"
                variant="link"
                className="mt-3 h-8 px-3 text-sm font-normal text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                onClick={() => void onOpenRegistration()}
              >
                注册
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-destructive mt-3 max-w-[288px] text-xs leading-5">
                {error}
              </p>
            )}
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
              className="mt-2 h-11 rounded-xl border-white/75 bg-white/72 px-4 text-sm shadow-sm shadow-slate-400/5 dark:border-white/25 dark:bg-slate-800/52 dark:shadow-black/20"
              autoFocus
            />
            {error && <p className="text-destructive mt-2 px-1 text-xs">{error}</p>}
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Button
                type="button"
                className="h-10 rounded-full border-white/75 bg-white/72 text-slate-800 hover:bg-white/88 dark:border-white/25 dark:bg-slate-800/52 dark:text-slate-100 dark:hover:bg-slate-700/68"
                disabled={busy}
                onClick={() => {
                  setView("choices");
                  setError("");
                }}
              >
                取消
              </Button>
              <Button
                type="submit"
                className="h-10 rounded-full border-white/75 bg-white/92 text-slate-900 hover:bg-white dark:border-white/30 dark:bg-slate-100/76 dark:text-slate-900 dark:hover:bg-slate-100/88"
                disabled={busy}
              >
                {busy && <LoaderCircle className="animate-spin" />}
                继续
              </Button>
            </div>
          </form>
        )}

        {view === "browser" && (
          <>
            <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">请继续在浏览器中登录</p>
            {error && <p className="text-destructive mt-2 text-xs">{error}</p>}
            <div className="w-full max-w-[288px]">
              <Button
                type="button"
                variant="outline"
                className="mt-7 h-10 w-full rounded-full border-white/75 bg-white/72 text-slate-800 hover:bg-white/88 dark:border-white/25 dark:bg-slate-800/52 dark:text-slate-100 dark:hover:bg-slate-700/68"
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
