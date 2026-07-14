import {
    CLUSTER_DISPLAY,
    FAIRSHARE_HISTORY_PATH,
    HISTORY_CLUSTERS,
    HISTORY_SERIES,
    SERIES_COLORS,
    SERIES_DASHARRAY,
    SERIES_DISPLAY,
} from '../constants';
import type {
    HistoryRow,
    JobHistoryData,
} from '../types';
import { DASHBOARD_STYLES } from './styles';
import { DASHBOARD_SCRIPT } from './script';
import { downsampleRows, packRows } from './derive';
import type { EventRecord, IntervalRecord } from './derive';

const CHART_WIDTH = 1120;
const CHART_HEIGHT = 620;

// Cap on job/node history rows shipped to the webview. At the monitor's ~1-minute
// cadence this is still ~5-6 days at full resolution and coarser further back —
// plenty for the overlay line and stats, and it keeps the payload small enough to
// deliver in well under a second.
const MAX_METRIC_ROWS = 8000;

function humanizeJobMetricLabel(metricKey: string): string {
    return metricKey
        .split('_')
        .map((part) => {
            const lower = part.toLowerCase();
            if (lower === 'cpu' || lower === 'gpu') {
                return lower.toUpperCase();
            }
            if (lower === 'fir') { return 'Fir'; }
            if (lower === 'ror') { return 'Rorqual'; }
            if (lower === 'nibi') { return 'Nibi'; }
            if (lower === 'tril') { return 'Trillium'; }
            if (lower === 'nar') { return 'Narval'; }
            return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join(' ');
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// A serializable object sent to the webview via postMessage. Deliberately holds
// no raw job snapshots — only the columnar history plus the derived events and
// running intervals — so the payload stays small as history grows.
export interface DashboardPayload {
    chartWidth: number;
    chartHeight: number;
    series: string[];
    seriesLabels: Record<string, string>;
    seriesColors: Record<string, string>;
    seriesDasharray: Record<string, string>;
    clusters: Array<{ cluster: string; label: string; cpu: string; gpu: string }>;
    history: ReturnType<typeof packRows>;
    jobHistory: ReturnType<typeof packRows>;
    jobMetricKeys: string[];
    jobMetricLabels: Record<string, string>;
    nodeHistory: ReturnType<typeof packRows>;
    nodeMetricKeys: string[];
    nodeMetricLabels: Record<string, string>;
    events: EventRecord[];
    intervals: IntervalRecord[];
}

export function buildDashboardPayload(
    historyRows: HistoryRow[],
    jobHistory: JobHistoryData,
    nodeHistory: JobHistoryData,
    events: EventRecord[],
    intervals: IntervalRecord[],
): DashboardPayload {
    return {
        chartWidth: CHART_WIDTH,
        chartHeight: CHART_HEIGHT,
        series: [...HISTORY_SERIES],
        seriesLabels: SERIES_DISPLAY,
        seriesColors: SERIES_COLORS,
        seriesDasharray: SERIES_DASHARRAY,
        clusters: HISTORY_CLUSTERS.map((cluster) => ({
            cluster,
            label: cluster === 'tril' ? 'Trillium' : CLUSTER_DISPLAY[cluster],
            cpu: `${cluster}_cpu`,
            gpu: `${cluster}_gpu`,
        })),
        history: packRows(
            historyRows as unknown as Array<{ timestamp: string; values: Record<string, number | undefined> }>,
            HISTORY_SERIES,
        ),
        jobHistory: packRows(downsampleRows(jobHistory.rows, MAX_METRIC_ROWS), jobHistory.metricKeys),
        jobMetricKeys: jobHistory.metricKeys,
        jobMetricLabels: Object.fromEntries(
            jobHistory.metricKeys.map((key) => [key, humanizeJobMetricLabel(key)]),
        ),
        nodeHistory: packRows(downsampleRows(nodeHistory.rows, MAX_METRIC_ROWS), nodeHistory.metricKeys),
        nodeMetricKeys: nodeHistory.metricKeys,
        nodeMetricLabels: Object.fromEntries(
            nodeHistory.metricKeys.map((key) => [key, humanizeJobMetricLabel(key)]),
        ),
        events,
        intervals,
    };
}

// The webview is opened with this static shell immediately, then the payload is
// streamed in via postMessage once the (heavier) host-side data prep finishes.
export function buildDashboardShellHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>HPC Usage Dashboard</title>
    <style>${DASHBOARD_STYLES}</style>
</head>
<body>
    <h1>HPC Usage Dashboard</h1>
    <p class="subtle">Source: ${escapeHtml(FAIRSHARE_HISTORY_PATH)}</p>
    <div class="card">
        <div class="preset-row">
            <button class="preset-button" data-range="all">All</button>
            <button class="preset-button" data-range="1d">24H</button>
            <button class="preset-button active" data-range="7d">7D</button>
            <button class="preset-button" data-range="30d">30D</button>
            <button class="preset-button" data-range="90d">90D</button>
            <button class="preset-button" data-range="1y">1Y</button>
        </div>
        <div class="controls">
            <div class="control-group">
                <label for="startDate">Start</label>
                <input id="startDate" type="datetime-local" />
            </div>
            <div class="control-group">
                <label for="endDate">End</label>
                <input id="endDate" type="datetime-local" />
            </div>
        </div>
        <div class="metric-row">
            <label class="metric-toggle">
                <input id="toggleCpu" type="checkbox" checked />
                <span class="metric-toggle-label">CPU</span>
            </label>
            <label class="metric-toggle">
                <input id="toggleGpu" type="checkbox" checked />
                <span class="metric-toggle-label">GPU</span>
            </label>
            <select id="aggregationSelect" class="metric-select">
                <option value="raw">Raw</option>
                <option value="15m">15m</option>
                <option value="1h">1h</option>
                <option value="6h">6h</option>
            </select>
            <select id="clusterSelect" class="metric-select">
                <option value="all">All HPCs</option>
                <option value="fir">Fir</option>
                <option value="ror">Rorqual</option>
                <option value="nibi">Nibi</option>
                <option value="tril">Trillium</option>
                <option value="nar">Narval</option>
            </select>
            <select id="jobMetricSelect" class="metric-select"></select>
            <button id="clearSelection" class="secondary-button" type="button">Clear Selection</button>
        </div>
        <div class="chart-shell">
            <svg id="chart" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="Fairshare history chart"></svg>
            <div id="chartTooltip" class="tooltip"></div>
            <div id="loadingOverlay" class="loading-overlay">Loading dashboard data…</div>
        </div>
        <div id="metrics" class="metrics"></div>
        <div id="legend" class="legend"></div>
        <div id="selectionSummary" class="selection-summary"></div>
        <div id="jobStats" class="dashboard-stats"></div>
        <div id="efficiencyView" class="section-block"></div>
        <div id="lagCorrelationView" class="section-block"></div>
        <div id="eventTableView" class="section-block"></div>
        <div class="footer">The graph auto-zooms the y-axis to the selected date range so shallow fairshare changes are easier to see. Hover over the chart to inspect exact values at the nearest recorded sample.</div>
    </div>
    <script>${DASHBOARD_SCRIPT}</script>
</body>
</html>`;
}
