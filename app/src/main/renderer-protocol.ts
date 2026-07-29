import { readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

import { net, protocol } from "electron";

/**
 * The renderer is served from a custom scheme rather than `file://`.
 *
 * The frontend references public assets with root-absolute paths such as
 * `/mode-mascots/paper-plane/code.png`. Under `file://` those resolve against
 * the filesystem root and 404; under a `standard` scheme they resolve against
 * the scheme's host, which is what the code already assumes.
 */
export const RENDERER_SCHEME = "tietiezhi-app";
const RENDERER_HOST = "renderer";

export const RENDERER_ORIGIN = `${RENDERER_SCHEME}://${RENDERER_HOST}`;

/** Must be called before `app.whenReady()`. */
export function registerRendererScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RENDERER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot === -1 ? undefined : MIME[path.slice(dot).toLowerCase()]) ?? "application/octet-stream";
}

/** Serves the built renderer. `root` is the directory holding index.html. */
export function handleRendererScheme(root: string): void {
  protocol.handle(RENDERER_SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const decoded = decodeURIComponent(pathname);
    const target = normalize(join(root, decoded === "/" ? "/index.html" : decoded));

    // Reject traversal outside the bundle before touching the disk.
    if (target !== root && !target.startsWith(root + sep)) {
      return new Response("forbidden", { status: 403 });
    }

    try {
      const body = await readFile(target);
      return new Response(body, { headers: { "content-type": contentType(target) } });
    } catch {
      // Unknown paths are not SPA routes here: every entry is a real html file,
      // so a miss is a genuine 404 rather than something to rewrite.
      return new Response("not found", { status: 404 });
    }
  });
}

export { net };
