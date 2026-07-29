/**
 * Asset protocol shared by `convertFileSrc()` in the preload and the protocol
 * handler registered in the main process. Kept dependency-free so both sides
 * (and the bundlers that treat them as separate entries) can import it.
 */

/** Scheme handed to `protocol.registerSchemesAsPrivileged` / `protocol.handle`. */
export const ASSET_PROTOCOL = "tietiezhi-asset";

/**
 * Fixed authority. A custom scheme without a host produces URLs that Chromium
 * treats as opaque origins, which breaks `fetch()` and media elements.
 */
export const ASSET_HOST = "localhost";

/** `tietiezhi-asset://localhost/` — prefix of every URL we hand the webview. */
export const ASSET_URL_PREFIX = `${ASSET_PROTOCOL}://${ASSET_HOST}/`;

/**
 * Tauri's `convertFileSrc(path, protocol)` equivalent. The `protocol` argument
 * exists only for signature compatibility: the frontend never passes one, and
 * we always serve through our own scheme.
 */
export function convertFileSrc(filePath: string, _protocol?: string): string {
  return ASSET_URL_PREFIX + encodeURIComponent(filePath);
}

/**
 * Inverse of {@link convertFileSrc}, for the main-process protocol handler.
 * Returns `null` for anything that is not one of our asset URLs so callers can
 * reject the request instead of touching the filesystem.
 */
export function assetUrlToPath(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${ASSET_PROTOCOL}:`) return null;
  const encoded = parsed.pathname.replace(/^\//, "");
  if (encoded.length === 0) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}
