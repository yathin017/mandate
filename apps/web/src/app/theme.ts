/** Light/dark preference; stored per browser as a convenience only (storage may be unavailable). */
export type Theme = "light" | "dark";

export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem("mandate-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* storage blocked */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem("mandate-theme", theme);
  } catch {
    /* storage blocked */
  }
}
