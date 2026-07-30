/// <reference types="vite/client" />

import type { DesktopAPI } from "@shared/contracts";

declare global {
  interface Window {
    tietiezhi: DesktopAPI;
  }
}

export {};
