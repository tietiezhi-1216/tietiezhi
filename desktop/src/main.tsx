import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppMessageHost } from "@/components/app-message";
import { ThemeProvider } from "@/components/theme-provider";
import App from "@/App";
import { installGlobalErrorCapture } from "@/lib/error-report";
import "@/index.css";

const queryClient = new QueryClient();

/** `?mock` (dev only) stubs the Tauri bridge so the UI runs in a plain browser. */
async function bootstrap() {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
    const { installTauriMock } = await import("@/dev/tauri-mock");
    installTauriMock();
  }
  installGlobalErrorCapture();

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <App />
            <AppMessageHost />
          </TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </React.StrictMode>,
  );
}

void bootstrap();
