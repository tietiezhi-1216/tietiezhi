import { ArrowUp, Image as ImageIcon, LoaderCircle, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
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

import type { CreateController } from "./create-types";

export function CreateComposer({
  controller,
}: {
  controller: CreateController;
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
    cancel,
  } = controller;
  const selection = providerId && model ? `${providerId}\u0000${model}` : "";

  return (
    <form
      className="bg-card relative w-full overflow-hidden rounded-2xl border shadow-sm"
      onSubmit={(event) => {
        event.preventDefault();
        void generate();
      }}
    >
      <Textarea
        id="create-prompt"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="描述你想生成的图片"
        aria-label="图片描述"
        className="min-h-32 resize-none border-0 bg-transparent px-5 pt-5 pb-2 text-[15px] leading-7 shadow-none placeholder:text-muted-foreground/65 focus-visible:ring-0 dark:bg-transparent"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void generate();
          }
        }}
      />
      {error && (
        <p role="alert" className="px-5 pb-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2 px-3 pb-3">
        <Select
          value={selection}
          onValueChange={(value) => {
            const [nextProvider = "", nextModel = ""] = value.split("\u0000");
            setProvider(nextProvider);
            setModel(nextModel);
          }}
        >
          <SelectTrigger
            size="sm"
            className="max-w-72 border-0 bg-muted/70 shadow-none"
            aria-label="选择图片模型"
          >
            <ImageIcon className="text-muted-foreground size-3.5" />
            <SelectValue
              placeholder={
                providers.length > 0 ? "选择图片模型" : "请先配置图片模型"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {providers.length === 0 && (
              <SelectItem value="unavailable" disabled>
                暂无可用图片模型
              </SelectItem>
            )}
            {providers.map((provider) => (
              <SelectGroup key={provider.id}>
                <SelectLabel>{provider.displayName}</SelectLabel>
                {provider.imageModels.map((item) => (
                  <SelectItem
                    key={`${provider.id}:${item}`}
                    value={`${provider.id}\u0000${item}`}
                  >
                    {item}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>

        {running ? (
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={() => void cancel()}
            className="ml-auto size-9 rounded-full"
            aria-label="停止生成"
            title="停止生成"
          >
            <Square className="size-3.5 fill-current" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            disabled={busy || !prompt.trim() || !providerId || !model}
            className="ml-auto size-9 rounded-full"
            aria-label="生成图片"
            title="生成图片（⌘/Ctrl + Enter）"
          >
            {busy ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <ArrowUp className="size-4" />
            )}
          </Button>
        )}
      </div>
    </form>
  );
}
