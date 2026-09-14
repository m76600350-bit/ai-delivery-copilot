// Every Dashboard widget card uses this SAME fixed height, regardless of
// which grid row it lands in — not the grid's own row-stretch behavior
// (which only equalizes heights WITHIN one row, leaving different rows at
// different heights depending on their tallest widget). 360px is sized off
// the "Throughput по неделям" widget — a compact widget with a fixed-height
// chart and no auto-growing list — as the reference for what a widget
// "normally" looks like, with a bit of headroom added so the Burndown
// widget's "отставание N SP" caption line (below its own sprint-selector
// row + chart) doesn't get clipped by the scroll area.
//
// A widget whose content doesn't fit gets an internal `overflow-y-auto` on
// its content area (not the card itself), so the header/controls never move
// or clip — see any widget component's root div for the pattern:
//   <div className={`... ${fullScreen ? 'flex flex-col' : `${DASHBOARD_WIDGET_HEIGHT_CLASS} flex flex-col`}`}>
//     <div className="shrink-0">header/controls</div>
//     <div className="flex-1 min-h-0 overflow-y-auto">content</div>
//   </div>
// fullScreen (the "raскрыть на весь экран" modal) intentionally does NOT use
// the fixed height — the modal already gives the widget as much room as it
// needs, so constraining it there too would just force an extra scrollbar.
export const DASHBOARD_WIDGET_HEIGHT_CLASS = 'h-[360px]';

export function widgetHeightClass(fullScreen) {
  return fullScreen ? '' : DASHBOARD_WIDGET_HEIGHT_CLASS;
}
