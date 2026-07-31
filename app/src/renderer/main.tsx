import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import { ScrollbarVisibility } from "@/components/scrollbar-visibility";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <ScrollbarVisibility />
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
