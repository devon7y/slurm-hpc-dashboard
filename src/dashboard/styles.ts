export const DASHBOARD_STYLES = `
body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    margin: 20px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
}
h1 {
    font-size: 18px;
    margin: 0 0 6px 0;
}
.subtle {
    color: var(--vscode-descriptionForeground);
    margin: 0 0 16px 0;
}
.card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px;
    padding: 16px;
    background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editor-foreground) 8%);
}
.controls {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin-bottom: 16px;
}
.control-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.control-group label {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
}
.control-group input {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 6px;
    padding: 6px 8px;
}
.preset-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
}
.preset-button {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 999px;
    padding: 6px 10px;
    cursor: pointer;
}
.preset-button.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}
.metric-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin-bottom: 16px;
}
.metric-toggle {
    display: flex;
    align-items: center;
    gap: 10px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 8px 10px;
    user-select: none;
}
.metric-toggle input {
    margin: 0;
}
.metric-toggle-label {
    font-weight: 600;
}
.metric-select {
    min-width: 240px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 8px;
    padding: 8px 10px;
}
.secondary-button {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 8px 10px;
    cursor: pointer;
}
.chart-shell {
    position: relative;
    width: 100%;
    margin: 0 auto;
}
.chart-shell svg {
    width: 100%;
    height: auto;
    display: block;
}
.loading-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--vscode-editor-background);
    color: var(--vscode-descriptionForeground);
    font-size: 14px;
    z-index: 5;
}
.loading-overlay.hidden {
    display: none;
}
.axis-label {
    fill: var(--vscode-descriptionForeground);
    font-size: 12px;
}
.grid-line {
    stroke: var(--vscode-descriptionForeground);
    stroke-opacity: 0.38;
    stroke-width: 1.2;
    shape-rendering: crispEdges;
}
.legend {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
    margin-top: 16px;
}
.legend-item {
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 8px 10px;
}
.legend-line {
    width: 18px;
    border-top-width: 3px;
    border-top-style: solid;
    border-top-color: currentColor;
    flex: 0 0 auto;
}
.legend-label {
    font-weight: 600;
}
.legend-value {
    margin-left: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.footer {
    margin-top: 12px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
}
.empty {
    color: var(--vscode-descriptionForeground);
}
.tooltip {
    position: absolute;
    pointer-events: none;
    background: var(--vscode-editorHoverWidget-background);
    color: var(--vscode-editorHoverWidget-foreground);
    border: 1px solid var(--vscode-editorHoverWidget-border);
    border-radius: 8px;
    padding: 10px 12px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    font-size: 12px;
    line-height: 1.45;
    min-width: 180px;
    opacity: 0;
    transform: translate(12px, 12px);
    transition: opacity 90ms ease-out;
}
.tooltip.visible {
    opacity: 1;
}
.tooltip-title {
    font-weight: 700;
    margin-bottom: 6px;
}
.tooltip-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
}
.tooltip-swatch {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    flex: 0 0 auto;
}
.tooltip-value {
    margin-left: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.metrics {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 12px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
}
.selection-summary {
    margin-top: 16px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px;
    padding: 12px;
    background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-editor-foreground) 6%);
}
.selection-header {
    font-weight: 700;
    margin-bottom: 6px;
}
.selection-subtle {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    margin-bottom: 10px;
}
.selection-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
}
.selection-card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 10px;
}
.selection-card-title {
    font-weight: 700;
    margin-bottom: 6px;
}
.selection-metric {
    display: grid;
    grid-template-columns: 42px 70px 1fr;
    gap: 8px;
    align-items: baseline;
    font-size: 12px;
    margin-top: 4px;
}
.selection-metric strong {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.dashboard-stats {
    margin-top: 16px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px;
    padding: 12px;
    background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-editor-foreground) 6%);
}
.stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px;
}
.stats-card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 10px;
}
.stats-card-title {
    font-weight: 700;
    margin-bottom: 8px;
}
.stats-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-items: baseline;
    font-size: 12px;
    margin-top: 4px;
}
.stats-row strong {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.stats-delta {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    margin-left: 6px;
}
.section-block {
    margin-top: 16px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px;
    padding: 12px;
    background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-editor-foreground) 6%);
}
.section-title {
    font-weight: 700;
    margin-bottom: 6px;
}
.section-subtle {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    margin-bottom: 10px;
}
.event-table-wrap {
    overflow-x: auto;
}
.event-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
}
.event-table th,
.event-table td {
    padding: 8px 10px;
    border-top: 1px solid var(--vscode-panel-border);
    text-align: left;
    vertical-align: top;
}
.event-table th {
    color: var(--vscode-descriptionForeground);
    font-weight: 600;
}
.event-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 11px;
    font-weight: 700;
    border: 1px solid currentColor;
}
.event-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
}
.corr-grid,
.efficiency-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px;
}
.corr-card,
.eff-card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 10px;
}
.corr-title,
.eff-title {
    font-weight: 700;
    margin-bottom: 8px;
}
.corr-row,
.eff-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    font-size: 12px;
    margin-top: 4px;
}
.corr-row strong,
.eff-row strong {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
`;
