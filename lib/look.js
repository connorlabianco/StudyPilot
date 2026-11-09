// "Canvas look": themes, accent and nav colors, card styles, per-course colors and fonts.
// Pure CSS generation, shared by the Canvas page (content script) and the side panel preview.

export const DEFAULT_LOOK = {
  theme: "default",        // default | liquid | liquid-dark | dark | midnight | dim | paper
  accent: "",              // "" = Canvas's own
  nav: "",                 // left global navigation bar color
  cardStyle: "classic",    // classic | gradient | glass
  cardSize: 100,           // course card size, % of Canvas's (70–140)
  cardMinimal: false,      // no picture area: a slim color strip, the name and the buttons
  hideCardImages: false,
  cardColor: "course",     // course | none (no color: just the image or a neutral surface)
  radius: "rounded",       // square | rounded | extra
  font: "default",         // default | system | atkinson | nunito | plex | serif
  courseColors: {},        // courseId → "#hex"
  showGrade: true,
  showDue: true,
  scrollbars: true,        // style Canvas's page scrollbars to match the theme
};

export const SWATCHES = [
  ["Coral", "#e0603d"], ["Ocean", "#2f6fed"], ["Violet", "#7c4dff"], ["Forest", "#1f8a5b"],
  ["Rose", "#d6336c"], ["Gold", "#c99400"], ["Teal", "#0f9aa8"], ["Slate", "#4a5568"], ["Ink", "#1d2733"],
];

export const THEMES = [
  ["default", "Canvas"], ["liquid", "Glass"], ["liquid-dark", "Glass Dark"], ["dark", "Dark"], ["midnight", "Midnight"], ["dim", "Dim"], ["paper", "Paper"],
];

export const FONTS = {
  default: { label: "Canvas default", css: null },
  system: { label: "System", css: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` },
  atkinson: { label: "Atkinson Hyperlegible", css: `"Atkinson Hyperlegible", system-ui, sans-serif`, google: "Atkinson+Hyperlegible:wght@400;700" },
  nunito: { label: "Nunito", css: `"Nunito", system-ui, sans-serif`, google: "Nunito:wght@400;600;800" },
  plex: { label: "IBM Plex Sans", css: `"IBM Plex Sans", system-ui, sans-serif`, google: "IBM+Plex+Sans:wght@400;600" },
  serif: { label: "Serif", css: `Charter, "Iowan Old Style", Georgia, serif` },
};

const RADIUS = { square: 4, rounded: 12, extra: 20 };

// Dark themes invert the page (so every Canvas screen goes dark, including parts with no class names),
// then flip photos, videos, course colors and StudyPilot's own UI back so they look right.
// The page is flipped with a *full* invert + 180° hue turn, and pictures get the very same filter again,
// which cancels out exactly, so photos, videos and embeds look untouched. How dark each theme is comes from
// recoloring Canvas's backgrounds *before* the flip (light gray in → dark gray out), never from filtering.
// A plain invert(1): flipping twice is exactly the identity (a hue turn can't do that; it clips saturated colors).
const FLIP = "invert(1)";
// Colors we want to *see* on a flipped page are written pre-flipped
const flip = (hex) => {
  const m = String(hex).replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? "#" + m.slice(1).map((x) => (255 - parseInt(x, 16)).toString(16).padStart(2, "0")).join("") : hex;
};
// A lighter version of a color, for links and accents on dark backgrounds
const lighten = (hex, amt = 0.45) => {
  const m = String(hex).replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? "#" + m.slice(1).map((x) => Math.round(parseInt(x, 16) + (255 - parseInt(x, 16)) * amt).toString(16).padStart(2, "0")).join("") : hex;
};
const INVERT = {
  dark: { bg: "#181818", surface: "#e7e7e7", raised: "#dcdcdc" },
  midnight: { bg: "#000000", surface: null, raised: "#f0f0f0" },
  dim: { bg: "#2e2e2e", surface: "#d1d1d1", raised: "#c7c7c7" },
  "liquid-dark": { bg: "#0b0f1a", surface: null, raised: null, glass: true },
};
// Canvas's main page backgrounds and raised surfaces (cards, module rows, menus)
const SURFACES = "body, #application, #wrapper, #main, #content-wrapper, #content, #not_right_side, .ic-Layout-wrapper, .ic-Layout-contentMain, .ic-app-main-content, #right-side-wrapper, #right-side, #left-side, .ic-app-nav-toggle-and-crumbs, .ic-Dashboard-header, .ic-Dashboard-header__layout, #dashboard_header_container";
const RAISED = ".ic-DashboardCard, .ic-DashboardCard__header_content, .ic-DashboardCard__action-container, .context_module, .ig-header, .ig-row, .item-group-container, .ic-app-course-menu, .ui-dialog, .ui-widget-content, .ic-notification, table.ic-Table";
const REINVERT = [
  "img", "video", "iframe", "canvas", "picture", "embed", "object",
  ".ic-DashboardCard__header_image",
  ".ic-DashboardCard__header_hero:not(.ic-DashboardCard__header_image .ic-DashboardCard__header_hero)",
  "[style*='background-image']:not(.ic-DashboardCard__header_image)",
  // Text and marks drawn in course colors keep their real color
  ".ic-DashboardCard__header-title", ".ic-avatar", ".ic-DashboardCard__header-button-bg",
  ".sp-card", ".sp-x-panel", ".sp-chips", ".sp-fab", ".sp-module-quiz",
  // Canvas's global navigation bar is already dark: keep it as is
  "#header.ic-app-header", ".ic-app-header:not(#header)",
];

export const isDarkTheme = (t) => t in INVERT;

// Liquid Glass: translucent, frosted surfaces over a soft color field, with bright specular edges.
function liquidCss() {
  const glass = `background: rgba(255,255,255,.42) !important; -webkit-backdrop-filter: blur(24px) saturate(180%); backdrop-filter: blur(24px) saturate(180%);
  border: 1px solid rgba(255,255,255,.65) !important;
  box-shadow: 0 10px 34px -8px rgba(30,40,90,.18), inset 0 1px 0 rgba(255,255,255,.9), inset 0 -1px 0 rgba(255,255,255,.25) !important;`;
  const edge = `content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; padding: 1px;
  background: linear-gradient(140deg, rgba(255,255,255,.95), rgba(255,255,255,0) 28%, rgba(255,255,255,0) 72%, rgba(255,255,255,.6));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude;`;
  return `html, body { background:
  radial-gradient(1100px 700px at 8% -10%, #bfe0ff 0%, rgba(191,224,255,0) 60%),
  radial-gradient(900px 640px at 100% 0%, #ffd6ea 0%, rgba(255,214,234,0) 58%),
  radial-gradient(1000px 760px at 55% 115%, #d3fbe6 0%, rgba(211,251,230,0) 62%),
  linear-gradient(180deg, #eef3fa, #f4f1fb) fixed !important; }
#application, #wrapper, #main, #content-wrapper, #content, #not_right_side, .ic-Layout-wrapper, .ic-Layout-contentMain, .ic-app-main-content,
#right-side-wrapper, #right-side, #dashboard, .ic-DashboardCard__box, .ic-Dashboard-header, .ic-app-nav-toggle-and-crumbs,
.ic-Dashboard-header__layout, #dashboard_header_container, .ic-Dashboard-header__title, .ic-Dashboard-header__actions { background: transparent !important; }
.ic-app-header, #header.ic-app-header { background: rgba(28,36,58,.62) !important; -webkit-backdrop-filter: blur(22px) saturate(160%); backdrop-filter: blur(22px) saturate(160%); }
.ic-DashboardCard { position: relative; ${glass} }
.ic-DashboardCard::after { ${edge} }
.ic-DashboardCard__header_hero { opacity: .62 !important; background-image: linear-gradient(165deg, rgba(255,255,255,.6) 0%, rgba(255,255,255,.08) 42%, rgba(255,255,255,0) 60%) !important; }
.ic-DashboardCard__header_image .ic-DashboardCard__header_hero { opacity: .38 !important; }
.ic-DashboardCard__header_content, .ic-DashboardCard__action-container { background: transparent !important; }
.sp-card, .sp-x-panel { position: relative; ${glass} --sp-bg: rgba(255,255,255,.55); --sp-soft: rgba(255,255,255,.5); --sp-line: rgba(255,255,255,.7); }
.sp-card::after, .sp-x-panel::after { ${edge} }
.sp-card .sp-tab.on, .sp-x-tab.on { background: rgba(255,255,255,.85) !important; }
.sp-x { background: rgba(120,140,180,.25) !important; }
.context_module { background: rgba(255,255,255,.42) !important; border: 1px solid rgba(255,255,255,.7) !important; border-radius: 14px !important; overflow: hidden; margin-bottom: 16px !important;
  -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); }
.context_module .ig-header { background: rgba(255,255,255,.35) !important; }
.context_module .ig-row { background: transparent !important; border-bottom: 1px solid rgba(255,255,255,.6) !important; }
.header-bar, .header-bar-outer-container { background: transparent !important; }
.sp-chip { background: rgba(255,255,255,.6) !important; -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); box-shadow: inset 0 0 0 1px rgba(255,255,255,.8) !important; }`;
}

// Liquid Glass Dark. It rides on the dark flip (so pictures stay exact), which means everything that
// isn't flipped back is written in pre-flipped colors: light here = dark on screen.
function liquidDarkCss() {
  const glassPre = `background: rgba(239,235,221,.55) !important; -webkit-backdrop-filter: blur(26px) saturate(170%); backdrop-filter: blur(26px) saturate(170%);
  border: 1px solid rgba(0,0,0,.16) !important;
  box-shadow: 0 14px 40px -12px rgba(255,255,255,.55), inset 0 1px 0 rgba(0,0,0,.28), inset 0 -1px 0 rgba(0,0,0,.08) !important;`;
  const edgePre = `content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; padding: 1px;
  background: linear-gradient(140deg, rgba(0,0,0,.55), rgba(0,0,0,0) 30%, rgba(0,0,0,0) 70%, rgba(0,0,0,.3));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude;`;
  // StudyPilot's cards are flipped back, so they use real colors (no blur: a flipped element can't blur what's behind it correctly)
  const glassReal = `background: rgba(20,24,38,.66) !important; border: 1px solid rgba(255,255,255,.12) !important;
  box-shadow: 0 14px 40px -14px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.14) !important;`;
  const edgeReal = edgePre.replace(/rgba\(0,0,0,/g, "rgba(255,255,255,");
  return `html { background:
  radial-gradient(1100px 700px at 8% -10%, #ebdbb5 0%, rgba(235,219,181,0) 60%),
  radial-gradient(900px 640px at 100% 0%, #c5e7bf 0%, rgba(197,231,191,0) 58%),
  radial-gradient(1000px 760px at 55% 115%, #f1c5cb 0%, rgba(241,197,203,0) 62%),
  linear-gradient(180deg, #f4f0e5, #f0f3e8) fixed !important; }
body, #application, #wrapper, #main, #content-wrapper, #content, #not_right_side, .ic-Layout-wrapper, .ic-Layout-contentMain, .ic-app-main-content,
#right-side-wrapper, #right-side, #left-side, #dashboard, .ic-DashboardCard__box, .ic-Dashboard-header, .ic-app-nav-toggle-and-crumbs,
.ic-Dashboard-header__layout, #dashboard_header_container, .ic-Dashboard-header__title, .ic-Dashboard-header__actions { background: transparent !important; }
.ic-app-header, #header.ic-app-header { background: rgba(12,16,28,.78) !important; }
.ic-DashboardCard { position: relative; ${glassPre} }
.ic-DashboardCard::after { ${edgePre} }
.ic-DashboardCard__header_hero { opacity: .7 !important; background-image: linear-gradient(165deg, rgba(255,255,255,.42) 0%, rgba(255,255,255,.06) 42%, rgba(255,255,255,0) 60%) !important; }
.ic-DashboardCard__header_image .ic-DashboardCard__header_hero { opacity: .4 !important; }
.ic-DashboardCard__header_content, .ic-DashboardCard__action-container { background: transparent !important; }
.context_module, .ig-header, .ig-row, .item-group-container, .ic-app-course-menu, table.ic-Table { background: rgba(239,235,221,.45) !important; }
html[data-sp-theme="liquid-dark"] :is(.sp-card, .sp-x-panel) { position: relative; ${glassReal}
  --sp-bg: rgba(20,24,38,.66); --sp-soft: rgba(255,255,255,.07); --sp-line: rgba(255,255,255,.1); }
html[data-sp-theme="liquid-dark"] :is(.sp-card, .sp-x-panel)::after { ${edgeReal} }
html[data-sp-theme="liquid-dark"] .sp-card .sp-tab.on, html[data-sp-theme="liquid-dark"] .sp-x-tab.on { background: rgba(255,255,255,.14) !important; }
html[data-sp-theme="liquid-dark"] .sp-x-panel { background: rgba(16,20,32,.86) !important; }`;
}

export function fontLink(look) {
  const f = FONTS[look.font];
  return f?.google ? `https://fonts.googleapis.com/css2?family=${f.google}&display=swap` : null;
}

export function buildLookCss(look = DEFAULT_LOOK) {
  const L = { ...DEFAULT_LOOK, ...look };
  const css = [];

  // Theme
  const inv = INVERT[L.theme];
  if (inv) {
    // The root background is flipped too, so it's given in pre-flipped form
    css.push(`html { filter: ${FLIP} !important; background: ${inv.glass ? "#f4f0e5" : inv.surface || "#ffffff"} !important; }`);
    if (inv.glass) css.push(liquidDarkCss());
    // Canvas's link and button colors, pre-flipped so they come out as a readable light accent
    const want = lighten(L.accent || "#2b7abc", 0.35), btn = L.accent || "#2b7abc";
    css.push(`:root { --ic-link-color: ${flip(want)} !important; --ic-brand-primary: ${flip(btn)} !important;
  --ic-brand-button--primary-bgd: ${flip(btn)} !important; --ic-brand-button--primary-text: #000 !important; }
:is(#content, #right-side, #left-side, .ic-app-course-menu, #breadcrumbs) a:not(.btn):not(.Button):not([class*="ic-DashboardCard"]):not(.sp-card a) { color: ${flip(want)} !important; }
.btn-primary, .Button--primary { background: ${flip(btn)} !important; border-color: ${flip(btn)} !important; color: #000 !important; }
/* Canvas's blue icons (and tools like Ally) would come out orange after the flip; turning their hue back fixes that.
   Only line icons get this, never pictures, so photos stay exact. */
:is(#content, #right-side, #left-side) svg:not(:is(.sp-card, .sp-x-panel, .sp-chips) svg), :is(#content, #right-side) [class*="ally-"] :is(svg, i) { filter: hue-rotate(180deg); }
/* Canvas's blue count bubbles (unread announcements etc.) likewise */
.ic-DashboardCard__action-badge { filter: hue-rotate(180deg); }
/* Modules: each module and each item gets a clear box (pre-flipped: these come out as soft light lines) */
.context_module { border: 1px solid rgba(0,0,0,.2) !important; border-radius: 14px !important; overflow: hidden; margin-bottom: 16px !important; }
.context_module .ig-header { border-bottom: 1px solid rgba(0,0,0,.16) !important; }
.context_module .ig-row, .ig-list .ig-row { border-bottom: 1px solid rgba(0,0,0,.11) !important; }
.context_module_item:hover .ig-row, .ig-list li:hover .ig-row { background-color: rgba(0,0,0,.05) !important; }
.header-bar, .header-bar-outer-container, #content .header-bar, .sticky-toolbar { background: transparent !important; }`);
    if (inv.surface) css.push(`${SURFACES} { background-color: ${inv.surface} !important; }`);
    if (inv.raised) css.push(`${RAISED} { background-color: ${inv.raised} !important; }`);
    // Pictures, videos and embeds: the same filter again = exactly their original colors
    css.push(`${REINVERT.join(",\n")} { filter: ${FLIP} !important; }`);
    // ...but never twice: media inside something already flipped back stays as is
    css.push(`:is(${REINVERT.filter((x) => !/^(img|video|iframe|canvas|picture|embed|object)$/.test(x)).join(", ")}) :is(img, video, iframe, canvas, picture, embed, object, [style*='background-image']) { filter: none !important; }`);
    // StudyPilot's own pieces render with real dark colors after being flipped back.
    // The html[data-sp-theme] prefix makes these win over the default styles.
    const T = `html[data-sp-theme="${L.theme}"]`;
    // Canvas marks the current nav item with a white block; in dark themes make it a soft highlight instead.
    css.push(`.ic-app-header__menu-list-item--active > .ic-app-header__menu-list-link, .ic-app-header__menu-list-item--active > a {
  background: rgba(255,255,255,.14) !important; box-shadow: inset 3px 0 0 ${lighten(L.accent || "#2f6fed", 0.38)} !important; }
.ic-app-header__menu-list-item--active :is(.menu-item__text, .ic-icon-svg, svg) { color: #fff !important; fill: #fff !important; }
.ic-app-header__menu-list-item--active .ic-avatar { border-color: #fff !important; }`);
    css.push(`${T} :is(.sp-card, .sp-x-panel) { --sp-ink:#eceff3; --sp-muted:#a3abb6; --sp-line:#2e333b; --sp-soft:#23272e; --sp-bg:#181b20; }
${T} .sp-card { box-shadow:none; }
${T} .sp-x { background: rgba(255,255,255,.55) !important; } /* pre-flipped: shows as a dark veil */
${T} :is(.sp-card, .sp-x-panel) .sp-due { background:#23272e; color:#a3abb6; }
${T} :is(.sp-card, .sp-x-panel) :is(.sp-late, .sp-now, .sp-score.low) { background:#47201d; color:#ff9b8f; }
${T} :is(.sp-card, .sp-x-panel) :is(.sp-soon, .sp-score.mid) { background:#3e2e14; color:#ffc46b; }
${T} :is(.sp-card, .sp-x-panel) :is(.sp-week, .sp-score.good) { background:#173326; color:#7fd8a5; }
${T} :is(.sp-card, .sp-x-panel) .sp-pill { background:#252c47; color:#a9b6ff; }
${T} .sp-chip { background:#262a31; color:#e6e9ee; box-shadow: inset 0 0 0 1px rgba(255,255,255,.08); }
${T} .sp-chip-due { background:#3e2e14; color:#ffc46b; box-shadow: inset 0 0 0 1px rgba(255,196,107,.18); }
${T} .sp-chip-due.soon { background:#47201d; color:#ff9b8f; box-shadow: inset 0 0 0 1px rgba(255,155,143,.2); }
${T} .sp-module-quiz { background:#1d2026; color:var(--sp-user-accent); border-color:var(--sp-user-accent); }`);
  } else if (L.theme === "liquid") {
    css.push(liquidCss());
  } else if (L.theme === "paper") {
    // Warm paper backgrounds only; no page filter, so pictures keep their real colors
    css.push(`html, ${SURFACES} { background-color: #f7f1e5 !important; }
${RAISED} { background-color: #fffaf0 !important; }
.ic-DashboardCard { border-color: #e9dfcc !important; }`);
  }

  // Accent: Canvas reads its brand colors from these variables (dark themes set their own, pre-flipped, above)
  if (L.accent && !inv) {
    css.push(`:root {
  --ic-brand-primary: ${L.accent} !important; --ic-link-color: ${L.accent} !important;
  --ic-brand-button--primary-bgd: ${L.accent} !important; --ic-brand-button--primary-text: #fff !important;
  --ic-brand-global-nav-ic-icon-svg-fill--active: ${L.accent} !important; --ic-brand-global-nav-menu-item__text-color--active: ${L.accent} !important;
}
#content a:not(.btn):not(.Button):not([class*="ic-DashboardCard"]), .ic-app-course-menu a.active, .ic-Action-header a { color: ${L.accent}; }
.btn-primary, .Button--primary, button[type=submit].btn-primary { background: ${L.accent} !important; border-color: ${L.accent} !important; color: #fff !important; }
#left-side #section-tabs .section a.active { border-left-color: ${L.accent} !important; }`);
  }

  // Global navigation bar
  if (L.nav) {
    css.push(`:root { --ic-brand-global-nav-bgd: ${L.nav} !important; }
#header.ic-app-header, .ic-app-header { background: ${L.nav} !important; }`);
  }

  // Cards
  const r = RADIUS[L.radius] ?? 12;
  css.push(`.ic-DashboardCard { border-radius: ${r}px !important; overflow: hidden; }
.ic-DashboardCard__header_image, .ic-DashboardCard__header_hero { border-radius: ${r}px ${r}px 0 0; }`);
  if (L.hideCardImages) {
    css.push(`.ic-DashboardCard__header_image { background-image: none !important; }
.ic-DashboardCard__header_hero { opacity: 1 !important; }`);
  }
  if (L.cardStyle === "gradient") {
    css.push(`.ic-DashboardCard__header_hero { background-image: linear-gradient(135deg, rgba(255,255,255,.28) 0%, rgba(255,255,255,0) 45%, rgba(0,0,0,.28) 100%) !important; }`);
  } else if (L.cardStyle === "glass") {
    css.push(`.ic-DashboardCard__header_hero { background-image: radial-gradient(120% 90% at 0% 0%, rgba(255,255,255,.45) 0%, rgba(255,255,255,0) 55%), radial-gradient(90% 80% at 100% 100%, rgba(0,0,0,.25) 0%, rgba(0,0,0,0) 60%) !important; }
.ic-DashboardCard { box-shadow: 0 10px 30px -12px rgba(16,24,40,.35) !important; border: 0 !important; }`);
  }
  // Size (Canvas's card is 262px wide with a 146px picture area) and minimal cards (no picture area)
  const size = Math.min(140, Math.max(70, Number(L.cardSize) || 100)) / 100;
  const minimal = L.cardMinimal || L.cardStyle === "minimal";
  if (size !== 1) css.push(`.ic-DashboardCard { width: ${Math.round(262 * size)}px !important; }
.ic-DashboardCard__header_image, .ic-DashboardCard__header_hero { height: ${Math.round(146 * size)}px !important; }`);
  if (minimal) css.push(`.ic-DashboardCard__header_image, .ic-DashboardCard__header_hero { height: 8px !important; min-height: 8px !important; }
.ic-DashboardCard__header_image { background-image: none !important; }
.ic-DashboardCard__header_hero { opacity: 1 !important; background-image: none !important; }
.ic-DashboardCard__header-button-bg, .ic-DashboardCard__header-button { top: 10px !important; }
.ic-DashboardCard { box-shadow: none !important; }`);

  // No color: drop the course tint so the card shows just its image (or a neutral surface)
  const noColor = (scope) => `${scope} .ic-DashboardCard__header_hero { background-color: transparent !important; ${L.theme === "liquid" ? "" : "background-image: linear-gradient(135deg, rgba(127,127,127,.10), rgba(127,127,127,.02)) !important;"} }
${scope} .ic-DashboardCard__header_image .ic-DashboardCard__header_hero { background-image: none !important; }
${scope} .ic-DashboardCard__header-title, ${scope} .ic-DashboardCard__header-title span { color: inherit !important; }`;
  if (L.cardColor === "none") css.push(noColor(".ic-DashboardCard"));

  // Per-course colors (card, title); "none" = no color for just that course
  for (const [id, color] of Object.entries(L.courseColors || {})) {
    if (color === "none") { css.push(noColor(`.ic-DashboardCard:has(a[href$="/courses/${id}"])`)); continue; }
    if (!/^#[0-9a-f]{3,8}$/i.test(color)) continue;
    const card = `.ic-DashboardCard:has(a[href$="/courses/${id}"])`;
    css.push(`${card} .ic-DashboardCard__header_hero { background-color: ${color} !important; }
${card} .ic-DashboardCard__header-title, ${card} .ic-DashboardCard__header-title span { color: ${color} !important; }`);
  }

  // Scrollbars: slim and rounded, accent on hover. Mid-gray works on light pages and inside the
  // inverted dark themes alike (a mid-gray stays mid-gray when inverted).
  if (L.scrollbars) {
    // Colors that match each theme (track = page background, thumb a step lighter/darker).
    // The page's own scrollbar is drawn outside the dark-theme flip, so it takes real colors; scrollbars
    // inside the page (lists, panels) are flipped with everything else, so they get pre-flipped colors.
    const SB = {
      default: ["#f3f4f6", "#b7bec8"], paper: ["#f3ecdf", "#cdbfa6"], liquid: ["#eef1f8", "#b4bfd8"],
      dark: ["#181818", "#4a4e56"], midnight: ["#000000", "#3a3d43"], dim: ["#2e2e2e", "#62656b"], "liquid-dark": ["#0b0f1a", "#39425e"],
    };
    const [track, thumb] = SB[L.theme] || SB.default;
    const hover = inv ? lighten(L.accent || "#2f6fed", 0.3) : L.accent || "#8d96a3";
    const rules = (scope, t, th, hv) => `${scope}::-webkit-scrollbar { width: 12px; height: 12px; }
${scope}::-webkit-scrollbar-track { background: ${t}; }
${scope}::-webkit-scrollbar-thumb { background: ${th}; border-radius: 99px; border: 3px solid ${t}; }
${scope}::-webkit-scrollbar-thumb:hover { background: ${hv}; }
${scope}::-webkit-scrollbar-corner { background: ${t}; }`;
    css.push(rules("html", track, thumb, hover));
    // Inner scroll areas: transparent track so they sit on whatever surface they're in
    css.push(rules("body ", "transparent", inv ? flip(thumb) : thumb, inv ? flip(hover) : hover).replace(/border: 3px solid transparent;/, "border: 3px solid transparent; background-clip: padding-box;"));
  }

  // Font (icons keep their own icon font)
  const f = FONTS[L.font];
  if (f?.css) {
    css.push(`body, button, input, select, textarea, .ic-app, .ic-DashboardCard, h1, h2, h3, h4, h5, h6 { font-family: ${f.css} !important; }
[class^="icon-"]::before, [class*=" icon-"]::before { font-family: "instructure_icons" !important; }`);
  }

  // StudyPilot's own accent on Canvas (links, counts, buttons) follows the chosen accent; calm blue by default.
  // Our widgets are shown in real colors even in dark themes, so dark themes get a lighter shade.
  css.unshift(`:root { --sp-user-accent: ${inv ? lighten(L.accent || "#2f6fed", 0.38) : L.accent || "#2f6fed"}; }`);
  return css.join("\n\n");
}
