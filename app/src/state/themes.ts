// Themes: measured colour families (see research/look/LOOK-SPEC.md) with our own names, plus generated
// gradient backdrops and a custom image. A theme sets CSS variables on :root and a family class on <html>.

export type Family = "default" | "dark" | "light-panel" | "dark-backdrop" | "dark-panel";

export interface Theme {
  id: string;
  name: string;
  family: Family;
  backdrop: string; // CSS background (colour or gradient)
  swatch: string;
  snippet?: string;
}

const gradient = (a: string, b: string, c?: string) => `linear-gradient(135deg, ${a} 0%, ${b} ${c ? "55%" : "100%"}${c ? `, ${c} 100%` : ""})`;

export const THEMES: Theme[] = [
  { id: "default", name: "Default", family: "default", backdrop: "#f8fafd", swatch: "#f8fafd" },
  { id: "dark", name: "Dark", family: "dark", backdrop: "#111111", swatch: "#111111" },
  { id: "sky", name: "Sky", family: "light-panel", backdrop: "#b2d5ee", swatch: "#b2d5ee" },
  { id: "mist", name: "Mist", family: "light-panel", backdrop: "#f5f5f5", swatch: "#e0e0e0" },
  { id: "lilac", name: "Lilac", family: "light-panel", backdrop: "#cab6eb", swatch: "#cab6eb" },
  { id: "blush", name: "Blush", family: "light-panel", backdrop: "#f5c0d0", swatch: "#f5c0d0" },
  { id: "honey", name: "Honey", family: "light-panel", backdrop: "#f6dc76", swatch: "#f6dc76" },
  { id: "lime", name: "Lime", family: "light-panel", backdrop: "#afd76b", swatch: "#afd76b" },
  { id: "mint", name: "Mint", family: "light-panel", backdrop: "#ddf0e4", swatch: "#ddf0e4" },
  { id: "lagoon", name: "Lagoon", family: "light-panel", backdrop: "#91dcdf", swatch: "#91dcdf" },
  { id: "twilight", name: "Twilight", family: "dark-backdrop", backdrop: "#55688a", swatch: "#55688a" },
  { id: "walnut", name: "Walnut", family: "dark-backdrop", backdrop: "#380e00", swatch: "#380e00" },
  { id: "plum", name: "Plum", family: "dark-panel", backdrop: "#6a627b", swatch: "#6a627b" },
  { id: "contrast", name: "High contrast", family: "light-panel", backdrop: "#eeeeee", swatch: "#ffffff", snippet: "#555555" },
  {
    id: "aurora",
    name: "Aurora",
    family: "dark-backdrop",
    backdrop: gradient("#0b3d5c", "#1f7a8c", "#7ad3b0"),
    swatch: gradient("#0b3d5c", "#1f7a8c", "#7ad3b0"),
  },
  { id: "dunes", name: "Dunes", family: "light-panel", backdrop: gradient("#f6d6a8", "#e9a87a", "#c97a5b"), swatch: gradient("#f6d6a8", "#e9a87a", "#c97a5b") },
  {
    id: "meadow",
    name: "Meadow",
    family: "light-panel",
    backdrop: gradient("#d9f0c2", "#9fd39a", "#5fae86"),
    swatch: gradient("#d9f0c2", "#9fd39a", "#5fae86"),
  },
  {
    id: "harbor",
    name: "Harbor",
    family: "dark-backdrop",
    backdrop: gradient("#1d2b44", "#36507a", "#8aa6c8"),
    swatch: gradient("#1d2b44", "#36507a", "#8aa6c8"),
  },
  { id: "custom", name: "Your image", family: "dark-backdrop", backdrop: "#333", swatch: "#666" },
];

export const themeById = (id: string) => THEMES.find((t) => t.id === id) ?? THEMES[0];

export function applyTheme(id: string, customImage: string | null) {
  const t = themeById(id);
  const root = document.documentElement;
  root.dataset.family = t.family;
  root.dataset.theme = t.id;
  const backdrop = t.id === "custom" && customImage ? `center / cover no-repeat url("${customImage}")` : t.backdrop;
  root.style.setProperty("--backdrop", backdrop);
  if (t.snippet) root.style.setProperty("--snippet", t.snippet);
  else root.style.removeProperty("--snippet");
  root.style.colorScheme = t.family === "dark" || t.family === "dark-panel" ? "dark" : "light";
  root.style.removeProperty("background");
  // For index.html, which puts the theme on before anything is drawn (the settings arrive later).
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify({ id: t.id, family: t.family, backdrop: t.id === "custom" ? null : t.backdrop }));
  } catch {
    // Storage off: the first frame uses the default theme.
  }
}

export const THEME_KEY = "courier.theme";
