// Shared by the server (for first paint) and the browser (for live editing).
export const PRESETS = {
  walnut: { label: 'Walnut', wood: '#5b3a24', woodDark: '#3a2416', woodLight: '#7d5236', back: '#2a1a10', plank: '#6b4429', page: '#1b130d', ink: '#efe4d0', accent: '#c9a45c', labelStyle: 'brass', lighting: 'warm', grain: 0.55, frame: true },
  oak: { label: 'Honey Oak', wood: '#a87b4f', woodDark: '#7a5533', woodLight: '#caa071', back: '#5e4128', plank: '#b5874f', page: '#ece3d3', ink: '#2b1f14', accent: '#8a5a2b', labelStyle: 'brass', lighting: 'warm', grain: 0.5, frame: true },
  mahogany: { label: 'Mahogany', wood: '#6e2b1e', woodDark: '#461910', woodLight: '#90402d', back: '#2b0f0a', plank: '#7a3324', page: '#170c09', ink: '#f2e2cf', accent: '#d8ad5a', labelStyle: 'brass', lighting: 'warm', grain: 0.5, frame: true },
  ebony: { label: 'Ebony', wood: '#2a2624', woodDark: '#151312', woodLight: '#3d3734', back: '#0e0d0c', plank: '#302b28', page: '#0b0b0b', ink: '#e9e3d9', accent: '#bdb6aa', labelStyle: 'chalk', lighting: 'spot', grain: 0.35, frame: true },
  birch: { label: 'White Birch', wood: '#ebe6dd', woodDark: '#d2cbbf', woodLight: '#faf7f2', back: '#f4efe6', plank: '#e2dbcf', page: '#faf8f4', ink: '#2c2a27', accent: '#8a7656', labelStyle: 'paper', lighting: 'none', grain: 0.18, frame: true },
  green: { label: 'Library Green', wood: '#2f4a3a', woodDark: '#1d3125', woodLight: '#41624e', back: '#1a2a21', plank: '#36533f', page: '#111c16', ink: '#ebe4cf', accent: '#cfa857', labelStyle: 'brass', lighting: 'warm', grain: 0.15, frame: true },
  navy: { label: 'Midnight Navy', wood: '#22324a', woodDark: '#141e2e', woodLight: '#30476a', back: '#111a28', plank: '#2a3d59', page: '#0c121d', ink: '#e7eaf1', accent: '#d9b562', labelStyle: 'brass', lighting: 'cool', grain: 0.12, frame: true },
  industrial: { label: 'Industrial', wood: '#4b5056', woodDark: '#2b2f33', woodLight: '#6c7279', back: '#24201d', plank: '#5b6168', page: '#161819', ink: '#e4e6e8', accent: '#e3a43b', labelStyle: 'chalk', lighting: 'spot', grain: 0, frame: true, brick: true },
  float: { label: 'Floating Glass', wood: '#c9d3d6', woodDark: '#9fb0b5', woodLight: '#eef4f5', back: 'transparent', plank: 'rgba(205,225,230,.55)', page: '#f2eee7', ink: '#25221f', accent: '#5f7d84', labelStyle: 'paper', lighting: 'none', grain: 0, frame: false, glass: true },
  cabin: { label: 'Log Cabin', wood: '#7a4f2c', woodDark: '#4e3019', woodLight: '#a06a3d', back: '#3a2414', plank: '#8b5a31', page: '#21160d', ink: '#f0e2c8', accent: '#e0a458', labelStyle: 'paper', lighting: 'warm', grain: 0.85, frame: true },
};

export const FONTS = {
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif",
  classic: "Garamond, 'EB Garamond', 'Times New Roman', serif",
  sans: "'Avenir Next', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  typewriter: "'American Typewriter', 'Courier Prime', 'Courier New', monospace",
  condensed: "'Avenir Next Condensed', 'Arial Narrow', 'Roboto Condensed', sans-serif-condensed, sans-serif",
};

export const THEME_KEYS = ['preset', 'wood', 'woodDark', 'woodLight', 'back', 'plank', 'page', 'ink', 'accent', 'labelStyle',
  'lighting', 'grain', 'frame', 'rowHeight', 'gap', 'font', 'spineFont', 'backImage', 'backImageMode', 'wallpaper', 'wallpaperMode', 'brick', 'glass', 'dust'];

/** Merge: preset defaults <- site overrides <- shelf overrides. */
export function resolveTheme(site = {}, shelf = {}) {
  const preset = shelf.preset || site.preset || 'walnut';
  const base = PRESETS[preset] || PRESETS.walnut;
  const merged = { rowHeight: 250, gap: 3, font: 'serif', spineFont: 'serif', backImageMode: 'cover', wallpaperMode: 'cover', ...base };
  // Colours from the site theme apply only when the shelf uses the site's preset.
  const siteOver = shelf.preset && shelf.preset !== site.preset ? {} : site;
  for (const src of [siteOver, shelf]) for (const k of THEME_KEYS) if (src[k] !== undefined && src[k] !== '' && src[k] !== null) merged[k] = src[k];
  merged.preset = preset;
  merged.frame = merged.frame !== false && merged.frame !== 'false';
  merged.rowHeight = Math.max(160, Math.min(380, Number(merged.rowHeight) || 250));
  return merged;
}

export function themeStyle(t) {
  const vars = {
    '--wood': t.wood, '--wood-dark': t.woodDark, '--wood-light': t.woodLight, '--back': t.back, '--plank': t.plank,
    '--page': t.page, '--ink': t.ink, '--accent': t.accent, '--grain': t.grain ?? 0.4, '--row-h': `${t.rowHeight}px`,
    '--gap': `${t.gap ?? 3}px`, '--font': FONTS[t.font] || FONTS.serif, '--spine-font': FONTS[t.spineFont] || FONTS.serif,
  };
  if (t.backImage) vars['--back-image'] = `url(/media/${Number(t.backImage)})`;
  if (t.wallpaper) vars['--wallpaper'] = `url(/media/${Number(t.wallpaper)})`;
  return Object.entries(vars).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}:${v}`).join(';');
}

export function themeClasses(t) {
  return ['bc', t.frame === false ? 'bc-noframe' : 'bc-frame', `bc-label-${t.labelStyle || 'brass'}`, `bc-light-${t.lighting || 'none'}`,
    t.brick ? 'bc-brick' : '', t.glass ? 'bc-glass' : '', t.backImage ? `bc-backimg bc-backimg-${t.backImageMode || 'cover'}` : '',
    t.dust ? 'bc-dust' : ''].filter(Boolean).join(' ');
}

export function pageStyle(t) {
  const parts = [`--page:${t.page}`, `--ink:${t.ink}`, `--accent:${t.accent}`, `--font:${FONTS[t.font] || FONTS.serif}`];
  if (t.wallpaper) parts.push(`--wallpaper:url(/media/${Number(t.wallpaper)})`);
  return parts.join(';');
}
