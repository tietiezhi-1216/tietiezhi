/**
 * Command registry behind `invoke()`. Feature modules (cores, config, skills,
 * ...) register their commands here; the bridge only routes.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { WebContents } from "electron";

import type { CommandHandler } from "@shared/contracts";

export interface InvocationContext {
  /** Command currently executing. */
  command: string;
  /** Renderer that issued the call — the target for events and channels. */
  sender: WebContents;
}

export interface CommandDescription {
  name: string;
  /** True for commands the bridge itself provides (`plugin:*`). */
  builtin: boolean;
}

export interface RegisterOptions {
  /** Allow taking over a name that is already registered. */
  replace?: boolean;
  /** Marks the command as bridge-provided in {@link describeRegisteredCommands}. */
  builtin?: boolean;
}

interface Entry {
  handler: CommandHandler;
  builtin: boolean;
}

const commands = new Map<string, Entry>();
const invocation = new AsyncLocalStorage<InvocationContext>();

/** Register one `invoke()` command. Throws on an unintended name collision. */
export function registerCommand(
  name: string,
  handler: CommandHandler,
  options: RegisterOptions = {},
): void {
  if (name.length === 0) throw new Error("registerCommand: command name must not be empty");
  if (commands.has(name) && options.replace !== true) {
    throw new Error(
      `registerCommand: "${name}" is already registered; pass { replace: true } to override it`,
    );
  }
  commands.set(name, { handler, builtin: options.builtin === true });
}

/** Register a batch of commands, e.g. one feature module's whole surface. */
export function registerCommands(
  handlers: Record<string, CommandHandler>,
  options: RegisterOptions = {},
): void {
  for (const [name, handler] of Object.entries(handlers)) {
    registerCommand(name, handler, options);
  }
}

export function unregisterCommand(name: string): boolean {
  return commands.delete(name);
}

export function hasCommand(name: string): boolean {
  return commands.has(name);
}

/** Sorted view of the registry, for diagnostics and the "unknown command" path. */
export function describeRegisteredCommands(): CommandDescription[] {
  return [...commands.entries()]
    .map(([name, entry]) => ({ name, builtin: entry.builtin }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Context of the `invoke()` currently on the stack. Handlers that need to push
 * events or channel messages back to their caller read the sender from here;
 * it is `undefined` outside a command.
 */
export function currentInvocation(): InvocationContext | undefined {
  return invocation.getStore();
}

/** Same, but throws with the reason instead of returning `undefined`. */
export function requireInvocation(): InvocationContext {
  const context = invocation.getStore();
  if (!context) {
    throw new Error("requireInvocation: called outside of an invoke() command handler");
  }
  return context;
}

/** Look up and run a command with its invocation context installed. */
export async function dispatchCommand(
  command: string,
  args: Record<string, unknown>,
  sender: WebContents,
): Promise<unknown> {
  const entry = commands.get(command);
  if (!entry) {
    throw new Error(
      `unknown command "${command}" — no handler is registered. ` +
        `Register it with registerCommand("${command}", handler). ` +
        `${commands.size} command(s) currently registered.`,
    );
  }
  return invocation.run({ command, sender }, async () => entry.handler(args));
}
