/**
 * Commands the frontend hits before any feature module is involved: the event
 * plugin (`listen`/`unlisten`), the app version shown in settings, and the
 * restart the updater performs. Everything else is registered by feature
 * modules.
 */

import { app } from "electron";

import { addEventListener, broadcastEvent, removeEventListener } from "./events";
import { registerCommands, requireInvocation } from "./registry";

function requireString(args: Record<string, unknown>, key: string, command: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`${command}: expected string argument "${key}"`);
  }
  return value;
}

function requireNumber(args: Record<string, unknown>, key: string, command: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${command}: expected integer argument "${key}"`);
  }
  return value;
}

let installed = false;

/** Idempotent: several windows may create a bridge over the same registry. */
export function registerBuiltinCommands(): void {
  if (installed) return;
  installed = true;

  registerCommands(
    {
      "plugin:event|listen": (args) => {
        const event = requireString(args, "event", "plugin:event|listen");
        // `handler` is the callback id the preload assigned to the listener.
        const handler = requireNumber(args, "handler", "plugin:event|listen");
        return addEventListener(event, handler, requireInvocation().sender);
      },

      "plugin:event|unlisten": (args) => {
        const event = requireString(args, "event", "plugin:event|unlisten");
        const eventId = requireNumber(args, "eventId", "plugin:event|unlisten");
        removeEventListener(event, eventId);
        return null;
      },

      // We have no window-label routing, so a targeted emit reaches every
      // listener of that event. Windows in this app never share event names.
      "plugin:event|emit": (args) => {
        broadcastEvent(requireString(args, "event", "plugin:event|emit"), args["payload"]);
        return null;
      },
      "plugin:event|emit_to": (args) => {
        broadcastEvent(requireString(args, "event", "plugin:event|emit_to"), args["payload"]);
        return null;
      },

      "plugin:app|version": () => app.getVersion(),
      "plugin:app|name": () => app.getName(),

      "plugin:process|restart": () => {
        app.relaunch();
        // Deferred so the invoke reply reaches the renderer first; `exit()`
        // skips the quit events, which is what Tauri's restart does too.
        setImmediate(() => app.exit(0));
        return null;
      },
      "plugin:process|exit": (args) => {
        const code = args["code"];
        setImmediate(() => app.exit(typeof code === "number" ? code : 0));
        return null;
      },
    },
    { builtin: true },
  );
}
