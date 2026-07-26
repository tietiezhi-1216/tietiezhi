import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  AudioLines,
  ChevronDown,
  Link2,
  Loader2,
  Mic,
  MicOff,
  Radio,
  Send,
  ShieldCheck,
  Smartphone,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  appendThreadRealtimeAudio,
  appendThreadRealtimeText,
  CODEX_V2_NOTIFICATION_EVENT,
  grantRemoteThread,
  listRemoteControlClients,
  readRemoteControlStatus,
  remoteThreadGrants,
  revokeRemoteControlClient,
  revokeRemoteThread,
  setRemoteControlEnabled,
  startRemoteControlPairing,
  startThreadRealtime,
  stopThreadRealtime,
  type CodexV2Notification,
  type RealtimeAudioChunk,
  type RemoteControlClient,
  type RemoteControlPairing,
  type RemoteControlStatus,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useCodexTimelineStore } from "@/stores/codex-timeline";

const INPUT_SAMPLE_RATE = 24_000;

export function RemoteRealtimePanel({
  threadId,
  embedded = false,
}: {
  threadId: string;
  embedded?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<RemoteControlStatus | null>(null);
  const [pairing, setPairing] = useState<RemoteControlPairing | null>(null);
  const [clients, setClients] = useState<RemoteControlClient[]>([]);
  const [grants, setGrants] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [text, setText] = useState("");
  const realtime = useCodexTimelineStore((state) => state.threads[threadId]?.realtime);
  const capture = useRef<{
    stream: MediaStream;
    context: AudioContext;
    source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode;
  } | null>(null);
  const playback = useRef<{ context: AudioContext; nextAt: number } | null>(null);

  const refreshRemote = async () => {
    const next = await readRemoteControlStatus();
    setStatus(next);
    if (!next.environmentId) {
      setClients([]);
      setGrants({});
      return;
    }
    const page = await listRemoteControlClients(next.environmentId);
    setClients(page.data);
    const entries = await Promise.all(
      page.data.map(async (client) => [
        client.clientId,
        await remoteThreadGrants(client.clientId),
      ] as const),
    );
    setGrants(Object.fromEntries(entries));
  };

  useEffect(() => {
    setOpen(false);
    setPairing(null);
    setText("");
    setFailure(null);
    stopCapture(capture);
  }, [threadId]);

  useEffect(() => {
    if (!open) return;
    void refreshRemote().catch((error) => setFailure(messageOf(error)));
  }, [open]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<CodexV2Notification>(CODEX_V2_NOTIFICATION_EVENT, (event) => {
      if (disposed) return;
      const notification = event.payload;
      if (notification.method === "remoteControl/status/changed") {
        setStatus(notification.params);
      }
      if (
        notification.method === "thread/realtime/outputAudio/delta" &&
        notification.params.threadId === threadId
      ) {
        playPcm16(notification.params.audio, playback).catch((error) =>
          setFailure(messageOf(error)),
        );
      }
      if (
        notification.method === "thread/realtime/closed" &&
        notification.params.threadId === threadId
      ) {
        stopCapture(capture);
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
      stopCapture(capture);
      void playback.current?.context.close();
      playback.current = null;
    };
  }, [threadId]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(null);
    }
  };

  const toggleRemote = () =>
    run("remote", async () => {
      const next = await setRemoteControlEnabled(status?.status === "disabled");
      setStatus(next);
      setPairing(null);
      await refreshRemote();
    });

  const pair = () =>
    run("pair", async () => {
      setPairing(await startRemoteControlPairing());
    });

  const toggleGrant = (client: RemoteControlClient) =>
    run(`grant:${client.clientId}`, async () => {
      const current = grants[client.clientId] ?? [];
      const next = current.includes(threadId)
        ? await revokeRemoteThread(client.clientId, threadId)
        : await grantRemoteThread(client.clientId, threadId);
      setGrants((all) => ({ ...all, [client.clientId]: next }));
    });

  const revokeClient = (client: RemoteControlClient) =>
    run(`revoke:${client.clientId}`, async () => {
      if (!status?.environmentId) return;
      await revokeRemoteControlClient(status.environmentId, client.clientId);
      await refreshRemote();
    });

  const toggleRealtime = () =>
    run("realtime", async () => {
      if (realtime?.active) {
        stopCapture(capture);
        await stopThreadRealtime(threadId);
        return;
      }
      await startThreadRealtime(threadId, "audio");
      try {
        await startCapture(threadId, capture);
      } catch (error) {
        await stopThreadRealtime(threadId).catch(() => undefined);
        throw error;
      }
    });

  const sendText = () =>
    run("text", async () => {
      const value = text.trim();
      if (!value) return;
      if (!realtime?.active) await startThreadRealtime(threadId, "audio");
      await appendThreadRealtimeText(threadId, value);
      setText("");
    });

  return (
    <section
      className={cn(
        "bg-card/75 overflow-hidden border shadow-sm",
        embedded
          ? "rounded-xl"
          : "relative z-10 mx-3 -mb-2 rounded-t-xl",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="hover:bg-muted/50 flex h-10 w-full items-center gap-2 px-3 text-left text-sm"
        aria-expanded={open}
      >
        <Radio className="size-4 text-cyan-600" />
        <span className="font-medium">Remote & Realtime</span>
        {realtime?.active && <Badge className="ml-1 bg-cyan-600">Live</Badge>}
        <span className="text-muted-foreground ml-auto text-xs">
          {status?.status ?? "未加载"}
        </span>
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          className={cn(
            "grid gap-4 border-t p-3",
            embedded
              ? "grid-cols-1"
              : "max-h-[min(48vh,34rem)] overflow-y-auto lg:grid-cols-2",
          )}
        >
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Smartphone className="size-4" />
              <span className="text-sm font-semibold">远程控制</span>
              <Switch
                className="ml-auto"
                checked={status?.status !== "disabled" && status != null}
                disabled={busy != null || status == null}
                onCheckedChange={() => void toggleRemote()}
                aria-label="启用远程控制"
              />
            </div>
            <p className="text-muted-foreground text-xs">
              远程客户端必须先配对，再由本机逐个授权当前 Thread。配对不会自动开放其他任务。
            </p>
            {status?.status !== "disabled" && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy != null}
                onClick={() => void pair()}
              >
                {busy === "pair" ? <Loader2 className="animate-spin" /> : <Link2 />}
                生成配对码
              </Button>
            )}
            {pairing && (
              <div className="border-cyan-500/30 bg-cyan-500/10 rounded-xl border p-3">
                <p className="text-muted-foreground text-xs">10 分钟内有效</p>
                <p className="mt-1 font-mono text-2xl font-semibold tracking-[0.25em]">
                  {pairing.manualPairingCode}
                </p>
              </div>
            )}
            <div className="space-y-2">
              {clients.map((client) => {
                const granted = (grants[client.clientId] ?? []).includes(threadId);
                return (
                  <div
                    key={client.clientId}
                    className="bg-background/70 flex items-center gap-2 rounded-xl border p-2"
                  >
                    <ShieldCheck
                      className={cn("size-4", granted ? "text-emerald-600" : "text-muted-foreground")}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">
                        {client.displayName || client.clientId}
                      </p>
                      <p className="text-muted-foreground truncate text-[11px]">
                        {[client.platform, client.deviceModel].filter(Boolean).join(" · ") ||
                          "远程客户端"}
                      </p>
                    </div>
                    <Button
                      variant={granted ? "secondary" : "outline"}
                      size="sm"
                      disabled={busy != null}
                      onClick={() => void toggleGrant(client)}
                    >
                      {granted ? "已授权" : "授权"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy != null}
                      onClick={() => void revokeClient(client)}
                      aria-label="撤销客户端"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                );
              })}
              {status?.status !== "disabled" && clients.length === 0 && (
                <p className="text-muted-foreground py-2 text-xs">暂无已配对客户端</p>
              )}
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <AudioLines className="size-4" />
              <span className="text-sm font-semibold">Realtime 对话</span>
              <Button
                className="ml-auto"
                variant={realtime?.active ? "destructive" : "default"}
                size="sm"
                disabled={busy != null}
                onClick={() => void toggleRealtime()}
              >
                {busy === "realtime" ? (
                  <Loader2 className="animate-spin" />
                ) : realtime?.active ? (
                  <MicOff />
                ) : (
                  <Mic />
                )}
                {realtime?.active ? "结束" : "开始"}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              使用 Codex Realtime WebSocket，输入为 24 kHz PCM16；网络断开后续接同一
              session，不会重放已发送音频或文本。
            </p>
            <div className="bg-background/70 min-h-24 rounded-xl border p-3 text-xs">
              {realtime?.inputTranscript && (
                <p>
                  <span className="text-muted-foreground mr-2">你</span>
                  {realtime.inputTranscript}
                </p>
              )}
              {realtime?.outputTranscript && (
                <p className="mt-2">
                  <span className="text-cyan-700 mr-2">Codex</span>
                  {realtime.outputTranscript}
                </p>
              )}
              {!realtime?.inputTranscript && !realtime?.outputTranscript && (
                <p className="text-muted-foreground">实时转写会显示在这里</p>
              )}
            </div>
            <div className="flex gap-2">
              <Input
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void sendText();
                }}
                placeholder="向 Realtime 会话追加文字"
              />
              <Button
                size="icon"
                disabled={!text.trim() || busy != null}
                onClick={() => void sendText()}
                aria-label="发送实时文字"
              >
                <Send />
              </Button>
            </div>
          </div>

          {failure && (
            <p
              className={cn(
                "text-destructive text-xs",
                !embedded && "lg:col-span-2",
              )}
              role="alert"
            >
              {failure}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

async function startCapture(
  threadId: string,
  capture: MutableRefObject<{
    stream: MediaStream;
    context: AudioContext;
    source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode;
  } | null>,
) {
  stopCapture(capture);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: INPUT_SAMPLE_RATE,
    },
  });
  const context = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event) => {
    const samples = event.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    void appendThreadRealtimeAudio(threadId, {
      data: bytesToBase64(new Uint8Array(pcm.buffer)),
      sampleRate: context.sampleRate,
      numChannels: 1,
      samplesPerChannel: pcm.length,
      itemId: null,
    }).catch(() => {
      // The lifecycle notification carries the actionable transport error.
    });
  };
  source.connect(processor);
  processor.connect(context.destination);
  capture.current = { stream, context, source, processor };
}

function stopCapture(
  capture: MutableRefObject<{
    stream: MediaStream;
    context: AudioContext;
    source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode;
  } | null>,
) {
  const active = capture.current;
  if (!active) return;
  active.processor.disconnect();
  active.source.disconnect();
  active.stream.getTracks().forEach((track) => track.stop());
  void active.context.close();
  capture.current = null;
}

async function playPcm16(
  chunk: RealtimeAudioChunk,
  playback: MutableRefObject<{ context: AudioContext; nextAt: number } | null>,
) {
  const bytes = base64ToBytes(chunk.data);
  if (bytes.byteLength % 2 !== 0) throw new Error("Realtime 音频不是 PCM16");
  let state = playback.current;
  if (!state || state.context.state === "closed") {
    state = {
      context: new AudioContext({ sampleRate: chunk.sampleRate }),
      nextAt: 0,
    };
    playback.current = state;
  }
  if (state.context.state === "suspended") await state.context.resume();
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const channels = Math.max(1, chunk.numChannels);
  const frames = Math.floor(samples.length / channels);
  const buffer = state.context.createBuffer(channels, frames, chunk.sampleRate);
  for (let channel = 0; channel < channels; channel += 1) {
    const output = buffer.getChannelData(channel);
    for (let frame = 0; frame < frames; frame += 1) {
      output[frame] = samples[frame * channels + channel] / 0x8000;
    }
  }
  const source = state.context.createBufferSource();
  source.buffer = buffer;
  source.connect(state.context.destination);
  const startsAt = Math.max(state.context.currentTime, state.nextAt);
  source.start(startsAt);
  state.nextAt = startsAt + buffer.duration;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const batch = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += batch) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + batch));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
