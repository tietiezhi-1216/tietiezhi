import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUp,
  FilePlus2,
  FolderPlus,
  ImageIcon,
  Loader2,
  Plus,
  Square,
} from "lucide-react";
import { ProductMascotMotion } from "@/components/product-mascot-motion";
import { ProductMotionStage } from "@/components/product-motion-stage";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { attachmentKind, ChatAssetCard } from "@/features/chat/chat-asset-card";
import {
  CHAT_COMPOSER_TEXTAREA_CLASS,
  ChatComposerSurface,
} from "@/features/chat/chat-composer-surface";
import { ModelSelect } from "@/features/chat/model-select";
import {
  chatCancel,
  errorMessage,
  listConnectedDevices,
  loadSettings,
  permissionRespond,
  pickChatFiles,
  pickChatFolder,
  tietiezhiStream,
} from "@/lib/api";
import type {
  AppSettings,
  ChatAttachment,
  ChatContentPart,
  ChatEvent,
  ChatMessage,
} from "@/lib/api";
import { modelInputModalities } from "@/lib/model-capabilities";
import { useTietiezhiStore } from "@/stores/tietiezhi";

const TIMELINE_KEY = "tietiezhi-main-timeline";

interface TimelineMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  attachments?: ChatAttachment[];
}

interface PendingPermission {
  id: string;
  description: string;
}

function readTimeline(): TimelineMessage[] {
  try {
    const value = JSON.parse(localStorage.getItem(TIMELINE_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? (value as TimelineMessage[]).slice(-200) : [];
  } catch {
    return [];
  }
}

function persistTimeline(messages: TimelineMessage[]): void {
  const compact = messages.slice(-200).map((message) => ({
    ...message,
    attachments: message.attachments?.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      mimeType: asset.mimeType,
      path: asset.path,
      size: asset.size,
      textContent: asset.textContent,
      truncated: asset.truncated,
    })),
  }));
  try {
    localStorage.setItem(TIMELINE_KEY, JSON.stringify(compact));
  } catch {
    // The in-memory timeline remains usable if the browser storage quota is full.
  }
}

function messageContent(message: TimelineMessage): ChatMessage["content"] {
  const attachments = message.attachments ?? [];
  const context = attachments
    .filter((asset) => attachmentKind(asset) !== "image")
    .map((asset) => {
      const label = attachmentKind(asset) === "folder" ? "attached_directory" : "attached_file";
      const metadata = [
        `name=${JSON.stringify(asset.name)}`,
        asset.path ? `path=${JSON.stringify(asset.path)}` : "",
        asset.mimeType ? `mime=${JSON.stringify(asset.mimeType)}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const body = asset.textContent
        ? `${asset.textContent}${asset.truncated ? "\n[内容已截断]" : ""}`
        : "[仅提供文件元数据]";
      return `<${label} ${metadata}>\n${body}\n</${label}>`;
    })
    .join("\n\n");
  const text = [message.content, context].filter(Boolean).join("\n\n");
  const images: ChatContentPart[] = attachments.flatMap((asset) =>
    attachmentKind(asset) === "image" && asset.dataUrl
      ? [{ type: "image_url", image_url: { url: asset.dataUrl } }]
      : [],
  );
  if (images.length === 0) return text;
  return [{ type: "text", text: text || "请查看附件。" }, ...images];
}

let nextRequestId = 20_000;

export function TietiezhiPage() {
  const selectedDeviceId = useTietiezhiStore((state) => state.selectedDeviceId);
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: loadSettings });
  const devicesQuery = useQuery({
    queryKey: ["tietiezhi", "devices"],
    queryFn: listConnectedDevices,
    refetchInterval: 15_000,
  });
  const devices = devicesQuery.data ?? [];
  const selected = devices.find((device) => device.id === selectedDeviceId) ?? devices[0];
  const settings = settingsQuery.data;
  const selectedProvider = settings?.providers.find(
    (provider) => provider.id === settings.chatProviderId,
  );
  const selectedModel = selectedProvider?.models.find(
    (model) => model.id === settings?.chatModel,
  );
  const modelReady = selectedModel != null;
  const supportsImageInput = selectedModel
    ? modelInputModalities(selectedModel).includes("image")
    : false;

  const [messages, setMessages] = useState<TimelineMessage[]>(readTimeline);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [assetBusy, setAssetBusy] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const requestIdRef = useRef<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasUnsupportedImages =
    !supportsImageInput && attachments.some((asset) => attachmentKind(asset) === "image");
  const attachmentStatus = hasUnsupportedImages
    ? "当前模型不支持已添加的图片，请更换模型或移除图片"
    : attachmentError;

  useEffect(() => {
    persistTimeline(messages);
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, status, permission]);

  const handleEvent = (event: ChatEvent, assistantId: string) => {
    switch (event.type) {
      case "delta":
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? { ...message, content: message.content + event.content }
              : message,
          ),
        );
        break;
      case "toolCallStart":
        setStatus("正在操作设备…");
        break;
      case "toolProgress":
        setStatus("正在操作设备…");
        break;
      case "toolResult":
        setStatus("");
        break;
      case "permissionRequest":
        setPermission({ id: event.id, description: event.description });
        setStatus("");
        break;
      case "retrying":
        setStatus("正在重新连接模型…");
        break;
      case "error":
        setError(event.message);
        setStatus("");
        setStreaming(false);
        requestIdRef.current = null;
        break;
      case "done":
        setStatus("");
        setStreaming(false);
        requestIdRef.current = null;
        break;
      default:
        break;
    }
  };

  const appendAssets = useCallback(
    (incoming: ChatAttachment[]) => {
      const rejectedImages = incoming.some(
        (asset) => attachmentKind(asset) === "image" && !supportsImageInput,
      );
      const candidates = incoming.filter(
        (asset) => attachmentKind(asset) !== "image" || supportsImageInput,
      );
      setAttachments((current) => {
        const next = [...current];
        const keys = new Set(current.map((asset) => asset.path || `${asset.name}:${asset.size}`));
        let imageCount = current.filter((asset) => attachmentKind(asset) === "image").length;
        for (const asset of candidates) {
          const key = asset.path || `${asset.name}:${asset.size}`;
          if (keys.has(key) || next.length >= 12) continue;
          if (attachmentKind(asset) === "image") {
            if (imageCount >= 4) continue;
            imageCount += 1;
          }
          keys.add(key);
          next.push(asset);
        }
        return next;
      });
      if (rejectedImages) {
        setAttachmentError("当前模型不支持图片输入");
      } else if (candidates.some((asset) => asset.truncated)) {
        setAttachmentError("部分内容已截断后加入上下文");
      } else {
        setAttachmentError("");
      }
    },
    [supportsImageInput],
  );

  const pickAssets = useCallback(
    async (kind: "image" | "file" | "folder") => {
      setAssetBusy(true);
      try {
        const assets =
          kind === "folder" ? await pickChatFolder() : await pickChatFiles(kind === "image");
        appendAssets(assets);
      } catch (cause) {
        setAttachmentError(errorMessage(cause));
      } finally {
        setAssetBusy(false);
      }
    },
    [appendAssets],
  );

  const submit = async () => {
    const text = input.trim();
    if (
      (!text && attachments.length === 0) ||
      streaming ||
      !selected ||
      !modelReady ||
      hasUnsupportedImages
    ) {
      return;
    }
    const pendingAttachments = attachments;
    const userMessage: TimelineMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      createdAt: Date.now(),
      attachments: pendingAttachments,
    };
    const assistantId = crypto.randomUUID();
    const assistantMessage: TimelineMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };
    const nextMessages = [...messages, userMessage];
    const transcript: ChatMessage[] = nextMessages.map((message) => ({
      role: message.role,
      content: messageContent(message),
    }));
    const requestId = nextRequestId++;
    requestIdRef.current = requestId;
    setMessages([...nextMessages, assistantMessage]);
    setInput("");
    setAttachments([]);
    setAttachmentError("");
    setError("");
    setStreaming(true);
    setStatus("正在思考…");
    try {
      await tietiezhiStream({
        requestId,
        deviceId: selected.id,
        deviceName: selected.name,
        messages: transcript,
        onEvent: (event) => handleEvent(event, assistantId),
      });
    } catch (cause) {
      setError(errorMessage(cause));
      setStreaming(false);
      setStatus("");
      requestIdRef.current = null;
    }
  };

  const stop = () => {
    if (requestIdRef.current != null) void chatCancel(requestIdRef.current);
  };

  const answerPermission = (decision: "allow" | "deny") => {
    if (!permission) return;
    void permissionRespond(permission.id, decision);
    setPermission(null);
    setStatus(decision === "allow" ? "正在操作设备…" : "已取消设备操作");
  };

  const composer = (
    <Composer
      input={input}
      setInput={setInput}
      attachments={attachments}
      attachmentError={attachmentStatus}
      assetBusy={assetBusy}
      settings={settings}
      modelReady={modelReady}
      supportsImageInput={supportsImageInput}
      selectedDeviceName={selected?.name}
      canSubmit={Boolean(selected) && modelReady && !hasUnsupportedImages}
      streaming={streaming}
      onPickAssets={pickAssets}
      onRemoveAsset={(id) =>
        setAttachments((current) => current.filter((asset) => asset.id !== id))
      }
      onSubmit={submit}
      onStop={stop}
    />
  );

  return (
    <main className="h-full bg-background">
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-4">
        {messages.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center pb-12">
            <ProductMotionStage
              variant="tietiezhi"
              className="-mb-4 h-52 w-[22rem]"
              mascotClassName="size-32"
            >
              <ProductMascotMotion
                src="/tietiezhi.png"
                variant="tietiezhi"
                intensity="stage"
                className="absolute inset-0 size-full"
              />
            </ProductMotionStage>
            {composer}
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto py-8">
              <div className="space-y-7">
                {messages.map((message) =>
                  message.content || message.attachments?.length ? (
                    <article key={message.id} className="text-sm leading-7">
                      <p className="text-muted-foreground mb-1 text-xs">
                        {message.role === "user" ? "你" : "铁铁汁"}
                      </p>
                      {message.attachments && message.attachments.length > 0 && (
                        <div className="mb-2 flex flex-wrap gap-2">
                          {message.attachments.map((asset) => (
                            <ChatAssetCard key={asset.id} asset={asset} />
                          ))}
                        </div>
                      )}
                      {message.content && (
                        <p className="whitespace-pre-wrap select-text">{message.content}</p>
                      )}
                    </article>
                  ) : null,
                )}
                {status && (
                  <p className="text-muted-foreground flex items-center gap-2 text-sm">
                    <Loader2 className="size-3.5 animate-spin" /> {status}
                  </p>
                )}
                {error && <p className="text-destructive text-sm">{error}</p>}
                <div ref={bottomRef} />
              </div>
            </div>

            <div className="shrink-0 pb-6">
              {permission && (
                <div className="mb-2 flex items-center gap-3 rounded-lg border px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{permission.description}</span>
                  <Button variant="ghost" size="sm" onClick={() => answerPermission("deny")}>
                    取消
                  </Button>
                  <Button size="sm" onClick={() => answerPermission("allow")}>
                    允许
                  </Button>
                </div>
              )}
              {composer}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function Composer({
  input,
  setInput,
  attachments,
  attachmentError,
  assetBusy,
  settings,
  modelReady,
  supportsImageInput,
  selectedDeviceName,
  canSubmit,
  streaming,
  onPickAssets,
  onRemoveAsset,
  onSubmit,
  onStop,
}: {
  input: string;
  setInput: (value: string) => void;
  attachments: ChatAttachment[];
  attachmentError: string;
  assetBusy: boolean;
  settings?: AppSettings;
  modelReady: boolean;
  supportsImageInput: boolean;
  selectedDeviceName?: string;
  canSubmit: boolean;
  streaming: boolean;
  onPickAssets: (kind: "image" | "file" | "folder") => Promise<void>;
  onRemoveAsset: (id: string) => void;
  onSubmit: () => Promise<void>;
  onStop: () => void;
}) {
  const composingRef = useRef(false);
  const compositionEndAt = useRef(0);
  const isImeEnter = (event: React.KeyboardEvent) =>
    composingRef.current ||
    event.nativeEvent.isComposing ||
    Date.now() - compositionEndAt.current < 100;

  return (
    <ChatComposerSurface className="w-full">
      {attachments.length > 0 && (
        <div className="flex gap-2 overflow-x-auto px-2 pt-1 pb-1.5">
          {attachments.map((asset) => (
            <ChatAssetCard
              key={asset.id}
              asset={asset}
              onRemove={() => onRemoveAsset(asset.id)}
            />
          ))}
        </div>
      )}
      <Textarea
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          compositionEndAt.current = Date.now();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || isImeEnter(event)) return;
          event.preventDefault();
          void onSubmit();
        }}
        placeholder={
          !modelReady
            ? "先选择一个对话模型"
            : selectedDeviceName
              ? `给铁铁汁发消息，在 ${selectedDeviceName} 上行动`
              : "给铁铁汁发消息"
        }
        autoFocus
        className={CHAT_COMPOSER_TEXTAREA_CLASS}
        rows={1}
      />
      <div className="flex min-w-0 items-center gap-1 pt-0.5 pl-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-7 shrink-0 rounded-full"
              disabled={assetBusy || attachments.length >= 12}
              aria-label="添加上下文"
              title="添加图片、文件或文件夹"
            >
              {assetBusy ? <Loader2 className="animate-spin" /> : <Plus />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-56">
            <DropdownMenuLabel>添加到本轮上下文</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!supportsImageInput}
              onSelect={() => void onPickAssets("image")}
            >
              <ImageIcon className="size-4" />
              <span className="flex-1">图片</span>
              <span className="text-muted-foreground text-[10px]">最多 4 张</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void onPickAssets("file")}>
              <FilePlus2 className="size-4" />
              <span className="flex-1">文件</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void onPickAssets("folder")}>
              <FolderPlus className="size-4" />
              <span className="flex-1">文件夹</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground font-normal">
              文件将作为本轮上下文发送
            </DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>
        <span
          className={
            attachmentError
              ? "text-destructive flex-1 truncate text-[11px]"
              : "text-muted-foreground flex-1 truncate text-[11px]"
          }
        >
          {attachmentError ||
            (modelReady ? "Enter 发送 · Shift+Enter 换行" : "选择模型后即可发送")}
        </span>
        <div className="shrink-0">
          {settings ? (
            <ModelSelect settings={settings} />
          ) : (
            <Loader2 className="text-muted-foreground mx-2 size-3.5 animate-spin" />
          )}
        </div>
        {streaming ? (
          <Button
            variant="outline"
            size="icon"
            className="size-8 shrink-0 rounded-full"
            onClick={onStop}
            aria-label="停止生成"
          >
            <Square />
          </Button>
        ) : (
          <Button
            size="icon"
            className="size-8 shrink-0 rounded-full"
            disabled={(!input.trim() && attachments.length === 0) || !canSubmit}
            onClick={() => void onSubmit()}
            aria-label="发送"
          >
            <ArrowUp />
          </Button>
        )}
      </div>
    </ChatComposerSurface>
  );
}
