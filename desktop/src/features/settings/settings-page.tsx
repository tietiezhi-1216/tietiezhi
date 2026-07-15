import { useQuery } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useTheme } from "@/components/theme-provider";
import type { Theme } from "@/components/theme-provider";

interface ThemeOption {
  value: Theme;
  label: string;
  icon: typeof Sun;
}

const THEME_OPTIONS: ThemeOption[] = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
];

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const versionQuery = useQuery({
    queryKey: ["appVersion"],
    queryFn: getVersion,
    retry: false,
    staleTime: Infinity,
  });

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6">
        <Card>
          <CardHeader>
            <CardTitle>外观</CardTitle>
            <CardDescription>主题默认跟随系统，也可手动指定。</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              {THEME_OPTIONS.map((opt) => (
                <Button
                  key={opt.value}
                  variant={theme === opt.value ? "default" : "outline"}
                  size="sm"
                  onClick={() => setTheme(opt.value)}
                >
                  <opt.icon /> {opt.label}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>关于</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-4">
            <img src="/tietiezhi.png" alt="铁铁汁" className="size-14 rounded-xl" />
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-semibold">铁铁汁 Tietiezhi</span>
              <span className="text-muted-foreground text-sm">
                连接各家模型的智能体终端 · v{versionQuery.data ?? "—"}
              </span>
              <Separator className="my-1" />
              <span className="text-muted-foreground text-xs">
                com.tietiezhi.tietiezhi · © 2026 Tietiezhi · 闭源软件，保留所有权利
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  );
}
