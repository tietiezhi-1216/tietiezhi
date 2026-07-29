# Tauri compatibility bridge

The renderer is the existing `desktop/` React frontend, unchanged. It talks to
the backend only through `@tauri-apps/api`, which bottoms out in a handful of
globals. This layer reproduces those globals so the frontend cannot tell it is
running on Electron.

```
renderer (desktop/)            preload (src/preload)              main (src/main/bridge)
  invoke("get_settings")  ->   __TAURI_INTERNALS__.invoke   ->   ipcMain.handle(IPC.invoke)
                                serialize args, wait                dispatchCommand -> CommandHandler
  handler(event)          <-   callback table (by id)       <-   emitEvent / emitChannel
```

## The `__TAURI_INTERNALS__` contract

`src/preload/index.ts` exposes exactly what `@tauri-apps/api` reads:

| Member                                  | Behaviour                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| `invoke(cmd, args?)`                    | One `IPC.invoke` round trip. Resolves with the handler's return value.                          |
| `transformCallback(fn, once?)`          | Stores `fn` in a preload-local table and returns its numeric id. Functions cannot cross IPC.     |
| `unregisterCallback(id)`                | Drops the callback. `Channel` calls this when the stream ends.                                   |
| `convertFileSrc(path)`                  | `tietiezhi-asset://localhost/<encodeURIComponent(path)>`.                                        |
| `metadata`                              | Empty — Tauri puts window labels here and the frontend never reads them.                         |

`@tauri-apps/api/event` additionally calls
`window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, eventId)`
inside `unlisten()`, so the preload exposes that too. `window.isTauri` is set so
`core.isTauri()` reports true.

### Rejections

`invoke()` rejects with a **plain string**, the way a Rust command returning
`Result<T, String>` does. `errorMessage()` in `desktop/src/lib/api.ts` is written
against that shape. Handlers may throw anything; the bridge reduces it to
`error.message` (or `String(error)`) before it reaches the renderer.

### Arguments

Tauri JSON-encodes the payload; Electron structured-clones it, and
`contextBridge` **drops prototypes** on the way out of the main world. So
`src/preload/serialize.ts` rebuilds JSON semantics before the payload is sent:
`undefined` members and functions are dropped, `Date` becomes an ISO string,
`bigint` a decimal string, non-finite numbers `null`, and cycles throw.

A `Channel` reaches the preload as a bare `{ id }` object — `toJSON()` and
`__TAURI_TO_IPC_KEY__()` are gone with the prototype. It is recognized by that
`id` being live in the callback table and is serialized to `"__CHANNEL__:<id>"`,
which is exactly what a Rust command would receive.

## Registering a command

```ts
import { registerCommand, registerCommands, requireInvocation, emitChannel, closeChannel, parseChannelId } from "./bridge";

registerCommand("get_settings", async () => loadSettings());

registerCommands({
  save_settings: async (args) => saveSettings(args["settings"]),
  list_cores: () => listCores(),
});
```

`CommandHandler` (from `@shared/contracts`) receives the raw
`Record<string, unknown>` payload — validate it yourself; the bridge does not
know your argument shapes. Registering a name twice throws unless you pass
`{ replace: true }`. `describeRegisteredCommands()` lists everything currently
registered, and an unknown command rejects with a message naming it, so missing
commands surface one at a time instead of failing silently.

### Streaming to a `Channel`

The frontend passes `new Channel()` as a command argument (`onEvent` in
`tietiezhi_stream`, `chat_stream`, ...):

```ts
registerCommand("tietiezhi_stream", async (args) => {
  const { sender } = requireInvocation();
  const channel = parseChannelId(args["onEvent"]);
  if (channel === null) throw new Error("tietiezhi_stream: onEvent must be a Channel");

  for await (const event of run()) emitChannel(sender, channel, event);
  closeChannel(sender, channel); // releases the renderer-side callback
});
```

Message order is preserved by an index the bridge maintains per channel;
`closeChannel` sends the end marker carrying the message count. Messages emitted
after `closeChannel` are ignored by the renderer.

### Pushing events

```ts
emitEvent(window, "codex-v2-notification", payload); // one window's listeners
broadcastEvent("dictation:start", null);             // every window that listens
```

`requireInvocation().sender` gives the `WebContents` that made the current call,
which is the right target for anything triggered by a command.

## Built-in commands

Registered by `createBridge()` itself:

- `plugin:event|listen`, `plugin:event|unlisten` — the subscription table behind
  `listen()`/`unlisten()`.
- `plugin:event|emit`, `plugin:event|emit_to` — renderer-originated events; both
  reach every listener of that name, since we have no window-label routing.
- `plugin:app|version`, `plugin:app|name` — from `app.getVersion()`/`getName()`.
- `plugin:process|restart` — `app.relaunch()` then `app.exit(0)`, deferred one
  tick so the reply reaches the renderer. Note that `exit()` skips `will-quit`,
  so teardown that must run before a restart belongs in `process.on("exit")` or
  in a replacement handler registered with `{ replace: true }`.
- `plugin:process|exit`.

`plugin:updater|*` is **not** implemented here; the updater feature owns it.
Until it is registered, `check()` rejects with the unknown-command error, which
the frontend's updater store treats as "no update".

## Mounting

```ts
const bridge = createBridge(window); // per BrowserWindow, safe to call repeatedly
// ...
bridge.dispose();                    // on window close, if you manage it manually
```

The command registry is process-wide; listener and channel state is per
renderer and is cleared when the window reloads (callback ids restart at 1 in
every new document) or is destroyed. The window must be created with
`contextIsolation: true` and the bundled preload from `out/preload/index.js`;
`sandbox` may stay enabled, as the preload bundle only requires `electron`.

## Asset protocol

`convertFileSrc()` produces `tietiezhi-asset://localhost/<encoded path>`. The
main process registers the scheme (privileged, so `fetch` and media elements
accept it) and resolves requests with `assetUrlToPath()`, both re-exported from
this module. Reject paths outside the directories you intend to serve — the
helper only decodes.
