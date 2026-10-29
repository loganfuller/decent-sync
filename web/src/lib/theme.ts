import { useSyncExternalStore } from "react";

/** The theme someone chose: Light or Dark, or System, which follows the device's appearance setting. */
export type ThemeChoice = "light" | "dark" | "system";

// The browser's own, not the Account's. The inline script in index.html reads the same key and values to paint the
// first frame in the chosen theme; anything else stored reads as System.
const KEY = "decent-sync-theme";
const deviceIsDark = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();
let current = stored();

function stored(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** Sets `.dark` and `color-scheme` on `<html>` as index.html's script does, so native controls match too. */
function apply() {
  const dark = current === "dark" || (current === "system" && deviceIsDark.matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

function changed(choice: ThemeChoice) {
  current = choice;
  apply();
  for (const listener of listeners) listener();
}

/**
 * Keeps the page in the chosen theme: under System it follows the device as it changes, and a choice made in
 * another tab applies here at once.
 */
export function followTheme() {
  apply();
  deviceIsDark.addEventListener("change", apply);
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) changed(stored());
  });
}

/** Applies a choice, and keeps it in this browser. Without storage it lasts until the page is closed. */
export function chooseTheme(choice: ThemeChoice) {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Kept for this page only.
  }
  changed(choice);
}

/** The choice in effect, which changes as it is made here or in another tab. */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, () => current);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
