import {
  ArrowUp,
  Image as ImageIcon,
  LoaderCircle,
  SlidersHorizontal,
  WandSparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import type { CreateController, ImageRatio } from "./create-types";

export function CreateComposer({
  controller,
  compact = false,
}: {
  controller: CreateController;
  compact?: boolean;
}) {
  const {
    providers,
    providerId,
    model,
    prompt,
    busy,
    running,
    error,
    setProvider,
    setModel,
    setPrompt,
    generate,
  } = controller;
  const selection = providerId && model ? `${providerId}\u0000${model}` : "";

  return (
    <form
      className={cn(
        "relative overflow-hidden rounded-[1.75rem] border border-white/8 bg-[#17191d] text-white shadow-[0_22px_80px_-38px_rgba(0,0,0,0.8)]",
        compact ? "p-3" : "p-4 sm:p-5",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        void generate();
      }}
    >
      <div className="pointer-events-none absolute -top-24 left-1/3 size-60 rounded-full bg-cyan-400/8 blur-3xl" />
      <div className={cn("relative flex items-start gap-3", compact ? "min-h-20" : "min-h-28")}>
        <span className="mt-1 grid size-12 shrink-0 rotate-[-7deg] place-items-center rounded-xl border border-white/10 bg-white/6 text-white/45">
          <WandSparkles className="size-4" />
        </span>
        <Textarea
          id="create-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="描述你想生成的图片、构图、光线和风格。"
          className={cn(
            "flex-1 resize-none border-0 bg-transparent px-0 py-1 text-[15px] leading-7 text-white shadow-none placeholder:text-white/30 focus-visible:ring-0 dark:bg-transparent",
            compact ? "min-h-20" : "min-h-28",
          )}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void generate();
            }
          }}
        />
      </div>
      {error && <p role="alert" className="relative mb-2 text-xs text-rose-300">{error}</p>}
      <div className="relative flex flex-wrap items-center gap-2 border-t border-white/7 pt-3">
        <span className="flex h-9 items-center gap-2 rounded-xl bg-white/7 px-3 text-xs">
          <ImageIcon className="size-3.5 text-cyan-300" />
          图片生成
        </span>
        <Select
          value={selection}
          onValueChange={(value) => {
            const [nextProvider = "", nextModel = ""] = value.split("\u0000");
            setProvider(nextProvider);
            setModel(nextModel);
          }}
        >
          <SelectTrigger className="h-9 w-auto max-w-72 gap-2 rounded-xl border-0 bg-white/7 px-3 text-white shadow-none hover:bg-white/10 focus-visible:ring-0 dark:bg-white/7">
            <SelectValue placeholder={providers.length > 0 ? "选择图片模型" : "请先配置图片模型"} />
          </SelectTrigger>
          <SelectContent>
            {providers.map((provider) => (
              <SelectGroup key={provider.id}>
                <SelectLabel>{provider.displayName}</SelectLabel>
                {provider.imageModels.map((item) => (
                  <SelectItem key={`${provider.id}:${item}`} value={`${provider.id}\u0000${item}`}>
                    {item}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <CreateParameters controller={controller} />
        <span className="ml-auto hidden text-[10px] text-white/25 sm:inline">
          使用 AI SDK 原生图片生成
        </span>
        <Button
          type="submit"
          size="icon"
          disabled={busy || running || !prompt.trim() || !providerId || !model}
          className="ml-auto size-10 rounded-full bg-white text-black hover:bg-cyan-100 disabled:bg-white/10 disabled:text-white/30 sm:ml-0"
          aria-label={running ? "正在生成" : "生成图片"}
          title={running ? "正在生成" : "生成图片（⌘/Ctrl + Enter）"}
        >
          {busy || running ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <ArrowUp className="size-4 stroke-[2.5]" />
          )}
        </Button>
      </div>
    </form>
  );
}

function CreateParameters({ controller }: { controller: CreateController }) {
  const { ratio, ratios, count, setRatio, setCount } = controller;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-2 rounded-xl bg-white/6 px-3 text-white hover:bg-white/10 hover:text-white data-[state=open]:bg-white/10"
        >
          <SlidersHorizontal className="size-3.5 text-white/55" />
          <span className="text-xs">{ratio} · {count} 张</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-76 p-4">
        <p className="text-xs font-semibold">画面比例</p>
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {ratios.map((item) => (
            <Button
              key={item}
              type="button"
              variant={ratio === item ? "secondary" : "outline"}
              size="sm"
              onClick={() => setRatio(item as ImageRatio)}
            >
              {item}
            </Button>
          ))}
        </div>
        <p className="mt-4 mb-2 text-xs font-semibold">生成数量</p>
        <Select value={String(count)} onValueChange={(value) => setCount(Number(value))}>
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[1, 2, 3, 4].map((value) => (
              <SelectItem key={value} value={String(value)}>{value} 张</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PopoverContent>
    </Popover>
  );
}
