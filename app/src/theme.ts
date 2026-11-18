import { useEffect, useState } from "react";

export type ThemeName = "catppuccin" | "kanagawa";
const KEY = "reride-theme";

function load(): ThemeName {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "kanagawa" || v === "catppuccin") return v;
  } catch {
    /* storage unavailable: fall back to the default */
  }
  return "catppuccin";
}

/** Applies the chosen palette to <html data-theme=...> and remembers it. Light/dark still follows the system. */
export function useTheme() {
  const [theme, setTheme] = useState<ThemeName>(load);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return { theme, setTheme };
}
