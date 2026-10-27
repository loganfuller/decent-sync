import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { TooltipProvider } from "@/components/ui/tooltip";
import { reloadForFailedChunk } from "@/lib/build";
import "./index.css";

// A chunk that fails to load, as one a deploy replaced, reloads the page once.
window.addEventListener("vite:preloadError", reloadForFailedChunk);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
