/**
 * Device interconnect and runtime diagnostics.
 *
 * A "device core" is another Tietiezhi instance reachable over HTTP that owns
 * its own devices. This module manages the list, probes reachability, and
 * forwards capability calls — either to this machine (`local`), to a core node
 * itself (`core:<id>`), or to a device behind a core (`<coreId>/<deviceId>`).
 *
 * Not ported: the WebSocket "device node" role, where this machine joins a
 * remote core's fabric and answers its calls. That needs the interconnect
 * envelope protocol and a reconnect loop, and nothing in the Electron host
 * drives it yet — see the module notes at the bottom.
 */

import { hostname } from "node:os";

import { app, BrowserWindow } from "electron";

import { describeRegisteredCommands, registerCommands } from "../bridge/index.js";
import { dataPath, readJson, writeJsonAtomic } from "./paths.js";
import {
  deleteDeviceCoreToken,
  getDeviceCoreToken,
  setDeviceCoreToken,
} from "./settings-secrets.js";

const STORE_VERSION = 1;
const PROBE_TIMEOUT_MS = 5_000;
const INVOKE_TIMEOUT_MS = 20_000;
const MAX_NAME_CHARS = 80;

interface DeviceCore {
  id: string;
  name: string;
  baseUrl: string;
  createdAt: number;
}

interface StoreFile {
  version: number;
  cores: DeviceCore[];
}

interface DeviceCoreView extends DeviceCore {
  online: boolean;
  latencyMs?: number;
  deviceCount: number;
  lastError: string;
  hasToken: boolean;
}

interface ConnectedDevice {
  id: string;
  nativeId: string;
  name: string;
  platform: string;
  coreId: string;
  coreName: string;
  role: "core" | "device";
  online: boolean;
  capabilities: string[];
}

interface DeviceInvokeResult {
  requestId: string;
  deviceId: string;
  capability: string;
  ok: boolean;
  output: unknown;
  message: string;
  durationMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new Error(`参数 ${name} 必须是字符串`);
  return value;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function storePath(): string {
  return dataPath("device-cores.json");
}

/** Serializes read-modify-write; two concurrent adds would otherwise lose one. */
let queue: Promise<unknown> = Promise.resolve();

function withStore<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

function parseCore(value: unknown): DeviceCore | null {
  if (!isRecord(value)) return null;
  const id = typeof value["id"] === "string" ? value["id"] : "";
  const baseUrl = typeof value["baseUrl"] === "string" ? value["baseUrl"] : "";
  if (id === "" || baseUrl === "") return null;
  return {
    id,
    name: typeof value["name"] === "string" ? value["name"] : id,
    baseUrl,
    createdAt: typeof value["createdAt"] === "number" ? value["createdAt"] : 0,
  };
}

async function readCores(): Promise<DeviceCore[]> {
  const stored = await readJson<unknown>(storePath(), null);
  if (!isRecord(stored)) return [];
  const cores = stored["cores"];
  if (!Array.isArray(cores)) return [];
  return cores.flatMap((entry) => {
    const core = parseCore(entry);
    return core ? [core] : [];
  });
}

async function writeCores(cores: DeviceCore[]): Promise<void> {
  const file: StoreFile = { version: STORE_VERSION, cores };
  await writeJsonAtomic(storePath(), file);
}

/**
 * Canonicalizes a core address, refusing anything that is not plain http(s).
 *
 * Credentials in the URL are rejected rather than stripped: silently dropping
 * them would leave the user believing the core is authenticated.
 */
function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("请输入完整的 http(s) 地址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("设备 Core 只支持 http 或 https 地址");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("地址中不能包含用户名或密码，请使用访问令牌");
  }
  url.search = "";
  url.hash = "";
  let path = url.pathname.replace(/\/+$/, "");
  // A pasted `/v1` suffix is the versioned API root, not part of the base.
  if (path.endsWith("/v1")) path = path.slice(0, -3);
  url.pathname = path.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function authHeaders(coreId: string): Promise<Record<string, string>> {
  const token = (await getDeviceCoreToken(coreId).catch(() => null))?.trim() ?? "";
  return token === "" ? {} : { Authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// Remote calls
// ---------------------------------------------------------------------------

interface RemoteDevice {
  id: string;
  name: string;
  platform: string;
  online?: boolean;
  capabilities?: string[];
}

function parseRemoteDevices(payload: unknown): RemoteDevice[] {
  if (!isRecord(payload)) return [];
  const devices = payload["devices"];
  if (!Array.isArray(devices)) return [];
  return devices.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = typeof entry["id"] === "string" ? entry["id"] : "";
    if (id === "") return [];
    return [
      {
        id,
        name: typeof entry["name"] === "string" ? entry["name"] : id,
        platform: typeof entry["platform"] === "string" ? entry["platform"] : "unknown",
        online: entry["online"] !== false,
        capabilities: Array.isArray(entry["capabilities"])
          ? entry["capabilities"].filter((value): value is string => typeof value === "string")
          : undefined,
      },
    ];
  });
}

async function fetchRemoteDevices(
  core: DeviceCore,
): Promise<{ devices: RemoteDevice[]; latencyMs: number }> {
  const started = Date.now();
  const response = await fetch(endpoint(core.baseUrl, "v1/devices"), {
    headers: await authHeaders(core.id),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw new Error(`无法连接：${String(error)}`);
  });
  if (!response.ok) throw new Error(`设备接口返回 HTTP ${String(response.status)}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`设备列表格式无效：${String(error)}`);
  }
  return { devices: parseRemoteDevices(payload), latencyMs: Date.now() - started };
}

async function coreView(core: DeviceCore): Promise<DeviceCoreView> {
  const token = (await getDeviceCoreToken(core.id).catch(() => null))?.trim() ?? "";
  const hasToken = token !== "";
  try {
    const { devices, latencyMs } = await fetchRemoteDevices(core);
    return {
      ...core,
      online: true,
      latencyMs,
      deviceCount: devices.length,
      lastError: "",
      hasToken,
    };
  } catch (error) {
    return {
      ...core,
      online: false,
      deviceCount: 0,
      lastError: error instanceof Error ? error.message : String(error),
      hasToken,
    };
  }
}

// ---------------------------------------------------------------------------
// Local device
// ---------------------------------------------------------------------------

function platformName(): string {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return process.platform;
  }
}

function localDeviceName(): string {
  const host = hostname().trim();
  if (host !== "") return host;
  switch (platformName()) {
    case "macos":
      return "这台 Mac";
    case "windows":
      return "这台 Windows 设备";
    default:
      return "当前设备";
  }
}

function capabilitiesFor(platform: string, role: "core" | "device"): string[] {
  if (role === "core") return ["core.health", "core.devices"];
  switch (platform.toLowerCase()) {
    case "android":
    case "ios":
      return [
        "system.status",
        "system.ping",
        "notification.send",
        "camera.capture",
        "location.read",
      ];
    case "macos":
    case "windows":
    case "linux":
      return [
        "system.status",
        "system.ping",
        "app.focus",
        "files.access",
        "terminal.execute",
        "browser.control",
      ];
    default:
      return ["system.status", "system.ping"];
  }
}

function localDevice(): ConnectedDevice {
  const platform = platformName();
  return {
    id: "local",
    nativeId: "local",
    name: localDeviceName(),
    platform,
    coreId: "local",
    coreName: "软件内嵌 Core",
    role: "device",
    online: true,
    capabilities: capabilitiesFor(platform, "device"),
  };
}

function localResult(requestId: string, capability: string, started: number): DeviceInvokeResult {
  const finish = (output: unknown, message: string): DeviceInvokeResult => ({
    requestId,
    deviceId: "local",
    capability,
    ok: true,
    output,
    message,
    durationMs: Date.now() - started,
  });

  switch (capability) {
    case "system.ping":
      return finish({ reply: "pong", at: Date.now() }, "本机响应正常");
    case "system.status":
      return finish(
        {
          name: localDeviceName(),
          platform: platformName(),
          arch: process.arch,
          appVersion: app.getVersion(),
          capabilities: capabilitiesFor(platformName(), "device"),
          at: Date.now(),
        },
        "本机状态已读取",
      );
    case "app.focus": {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("找不到主窗口");
      window.show();
      window.focus();
      return finish({ focused: true }, "窗口已聚焦");
    }
    default:
      throw new Error(`本机尚未实现设备能力：${capability}`);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function addDeviceCore(args: Record<string, unknown>): Promise<DeviceCoreView> {
  const name = requireString(args, "name").trim();
  if (name === "") throw new Error("请输入设备或 Core 名称");
  if ([...name].length > MAX_NAME_CHARS) throw new Error("名称不能超过 80 个字符");
  const baseUrl = normalizeBaseUrl(requireString(args, "baseUrl"));
  const rawToken = args["accessToken"];
  const token = typeof rawToken === "string" ? rawToken.trim() : "";

  const core: DeviceCore = {
    id: crypto.randomUUID(),
    name,
    baseUrl,
    createdAt: Date.now(),
  };

  await withStore(async () => {
    const cores = await readCores();
    if (cores.some((item) => item.baseUrl === core.baseUrl)) {
      throw new Error("这个 Core 地址已经添加");
    }
    cores.push(core);
    await writeCores(cores);
  });

  if (token !== "") {
    try {
      await setDeviceCoreToken(core.id, token);
    } catch (error) {
      // Roll the record back: a core listed without its token would look
      // configured while every call to it fails on auth.
      await withStore(async () => {
        await writeCores((await readCores()).filter((item) => item.id !== core.id));
      });
      throw error;
    }
  }

  return coreView(core);
}

async function removeDeviceCore(id: string): Promise<null> {
  await withStore(async () => {
    const cores = await readCores();
    const remaining = cores.filter((core) => core.id !== id);
    if (remaining.length === cores.length) throw new Error("设备 Core 不存在");
    await writeCores(remaining);
  });
  await deleteDeviceCoreToken(id).catch(() => undefined);
  return null;
}

async function requireCore(coreId: string): Promise<DeviceCore> {
  const core = (await readCores()).find((item) => item.id === coreId);
  if (core === undefined) throw new Error("设备 Core 不存在");
  return core;
}

async function listConnectedDevices(): Promise<ConnectedDevice[]> {
  const result: ConnectedDevice[] = [localDevice()];
  for (const core of await readCores()) {
    let remote: RemoteDevice[] = [];
    let online = false;
    try {
      remote = (await fetchRemoteDevices(core)).devices;
      online = true;
    } catch {
      // An unreachable core is still listed, marked offline, so the user can
      // see and fix it rather than having it vanish.
    }
    result.push({
      id: `core:${core.id}`,
      nativeId: core.id,
      name: core.name,
      platform: "core",
      coreId: core.id,
      coreName: core.name,
      role: "core",
      online,
      capabilities: capabilitiesFor("core", "core"),
    });
    for (const device of remote) {
      result.push({
        id: `${core.id}/${device.id}`,
        nativeId: device.id,
        name: device.name,
        platform: device.platform,
        coreId: core.id,
        coreName: core.name,
        role: "device",
        online: device.online !== false,
        capabilities: device.capabilities ?? capabilitiesFor(device.platform, "device"),
      });
    }
  }
  return result;
}

async function invokeDevice(args: Record<string, unknown>): Promise<DeviceInvokeResult> {
  const deviceId = requireString(args, "deviceId").trim();
  const capability = requireString(args, "capability").trim();
  if (deviceId === "" || capability === "") throw new Error("设备 ID 和能力不能为空");
  const input = args["input"];
  if (input !== undefined && input !== null && !isRecord(input)) {
    throw new Error("设备能力参数必须是 JSON 对象");
  }
  const started = Date.now();
  const requestId = crypto.randomUUID();

  if (deviceId === "local") return localResult(requestId, capability, started);

  if (deviceId.startsWith("core:")) {
    if (capability !== "core.health" && capability !== "core.devices") {
      throw new Error("Core 节点只支持 core.health 和 core.devices");
    }
    const core = await requireCore(deviceId.slice("core:".length));
    const { devices, latencyMs } = await fetchRemoteDevices(core);
    return {
      requestId,
      deviceId,
      capability,
      ok: true,
      output: {
        online: true,
        latencyMs,
        devices: devices.map((device) => ({
          id: device.id,
          name: device.name,
          platform: device.platform,
        })),
      },
      message: "Core 连接正常",
      durationMs: Date.now() - started,
    };
  }

  const separator = deviceId.indexOf("/");
  if (separator <= 0) throw new Error("远程设备 ID 格式无效");
  const core = await requireCore(deviceId.slice(0, separator));
  const targetId = deviceId.slice(separator + 1);

  const response = await fetch(endpoint(core.baseUrl, `v1/devices/${encodeURIComponent(targetId)}/invoke`), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders(core.id)) },
    body: JSON.stringify({ capability, input: input ?? {} }),
    signal: AbortSignal.timeout(INVOKE_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw new Error(`无法连接设备：${String(error)}`);
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`设备调用失败：HTTP ${String(response.status)}${text === "" ? "" : ` ${text}`}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("设备返回的数据不是有效 JSON");
  }
  const record = isRecord(payload) ? payload : {};
  return {
    requestId,
    deviceId,
    capability,
    ok: record["ok"] !== false,
    output: record["output"] ?? record,
    message: typeof record["message"] === "string" ? record["message"] : "",
    durationMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * The Tauri build reported on the embedded Codex Runtime. That runtime is gone,
 * so these report on what the Electron host actually has. Fields the UI expects
 * but the host cannot know are reported as empty rather than invented.
 */
async function doctorReport(): Promise<unknown> {
  const started = Date.now();
  const cores = await readCores();
  const reachable = await Promise.all(
    cores.map(async (core) => (await coreView(core)).online),
  );
  const offline = reachable.filter((online) => !online).length;

  const commandCount = describeRegisteredCommands().length;
  const checks = [
    {
      id: "host.commands",
      category: "host",
      status: "ok",
      summary: `已注册 ${String(commandCount)} 个宿主命令`,
      details: [`命令面在移植过程中会持续增加，当前 ${String(commandCount)} 个。`],
      issues: [],
      remediation: null,
      durationMs: 0,
    },
    {
      id: "device.cores",
      category: "interconnect",
      status: offline === 0 ? "ok" : "warning",
      summary:
        cores.length === 0
          ? "未添加任何设备 Core"
          : `${String(cores.length)} 个设备 Core，其中 ${String(offline)} 个不可达`,
      details: cores.map((core) => `${core.name} — ${core.baseUrl}`),
      issues:
        offline === 0
          ? []
          : [
              {
                severity: "warning",
                cause: "部分设备 Core 无法连接",
                measured: `${String(offline)} 个离线`,
                expected: "全部在线",
                remedy: "检查地址、网络与访问令牌",
                fields: ["baseUrl"],
              },
            ],
      remediation: offline === 0 ? null : "在「设备」面板重新探测或更新访问令牌",
      durationMs: Date.now() - started,
    },
  ];

  return {
    schemaVersion: 1,
    generatedAtMs: Date.now(),
    overallStatus: checks.some((check) => check.status === "fail")
      ? "fail"
      : checks.some((check) => check.status === "warning")
        ? "warning"
        : "ok",
    serviceVersion: app.getVersion(),
    checks,
  };
}

function runtimeMetrics(): unknown {
  // Only counters the host genuinely maintains. Inventing histogram values
  // would make the diagnostics panel actively misleading.
  return {
    counters: {
      "host.commands.registered": describeRegisteredCommands().length,
      "host.windows.open": BrowserWindow.getAllWindows().length,
      "process.uptime.seconds": Math.round(process.uptime()),
    },
    histograms: {},
  };
}

/**
 * Remote thread grants. The Tauri build kept these in the Codex Runtime; the
 * host keeps its own file so the UI round-trips correctly, but nothing consumes
 * them until the ACP bridge for remote threads exists.
 */
function grantsPath(): string {
  return dataPath("remote-thread-grants.json");
}

async function readGrants(): Promise<Record<string, string[]>> {
  const stored = await readJson<unknown>(grantsPath(), null);
  if (!isRecord(stored)) return {};
  const out: Record<string, string[]> = {};
  for (const [clientId, value] of Object.entries(stored)) {
    if (Array.isArray(value)) {
      out[clientId] = value.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return out;
}

async function mutateGrants(
  clientId: string,
  change: (current: string[]) => string[],
): Promise<string[]> {
  return withStore(async () => {
    const grants = await readGrants();
    const next = [...new Set(change(grants[clientId] ?? []))].sort();
    grants[clientId] = next;
    await writeJsonAtomic(grantsPath(), grants);
    return next;
  });
}

export function registerDeviceCommands(): void {
  registerCommands({
    list_device_cores: async () => Promise.all((await readCores()).map(coreView)),
    add_device_core: (args) => addDeviceCore(args),
    remove_device_core: (args) => removeDeviceCore(requireString(args, "id")),
    probe_device_core: async (args) => coreView(await requireCore(requireString(args, "id"))),
    list_connected_devices: () => listConnectedDevices(),
    invoke_device: (args) => invokeDevice(args),

    codex_doctor_report: () => doctorReport(),
    codex_runtime_metrics: () => runtimeMetrics(),

    // No telemetry exporter in the host yet; report "nothing exported" rather
    // than claiming success.
    codex_export_telemetry: () => false,

    codex_request_attestation: () => {
      throw new Error("当前版本尚不支持运行证明，等 ACP 桥接完成后提供");
    },

    codex_remote_grant_thread: (args) => {
      const threadId = requireString(args, "threadId");
      return mutateGrants(requireString(args, "clientId"), (current) => [...current, threadId]);
    },

    codex_remote_revoke_thread: (args) => {
      const threadId = requireString(args, "threadId");
      return mutateGrants(requireString(args, "clientId"), (current) =>
        current.filter((entry) => entry !== threadId),
      );
    },

    codex_remote_thread_grants: async (args) =>
      (await readGrants())[requireString(args, "clientId")] ?? [],
  });
}
