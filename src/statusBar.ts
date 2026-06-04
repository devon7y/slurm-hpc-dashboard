import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    FILE_PATH,
    HISTORY_SERIES,
    MAX_TOOLTIP_HISTORY_POINTS,
    SERIES_DISPLAY,
    SHOW_FAIRSHARE_GRAPH_COMMAND,
    SPARKLINE_BARS,
    STATUS_BAR_PRIORITY,
    STATUS_LABELS,
    UPDATE_INTERVAL_MS,
} from './constants';
import { readHistoryRows } from './dataReaders';
import type { HistoryRow, JobEntry } from './types';

let statusBarItem: vscode.StatusBarItem;
let fileWatcher: fs.FSWatcher | undefined;
let updateInterval: NodeJS.Timer | undefined;
let currentStatusText = '';

export function createStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        STATUS_BAR_PRIORITY,
    );
    statusBarItem.name = 'HPC Usage Dashboard';
    statusBarItem.tooltip = 'HPC Usage Dashboard';
    context.subscriptions.push(statusBarItem);
    return statusBarItem;
}

export function getCurrentStatusText(): string {
    return currentStatusText;
}

export function startMonitoring(): void {
    setupFileWatcher();
    updateInterval = setInterval(updateStatusBar, UPDATE_INTERVAL_MS);
    updateStatusBar();
}

export function stopMonitoring(): void {
    if (fileWatcher) {
        fileWatcher.close();
        fileWatcher = undefined;
    }
    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = undefined;
    }
}

function setupFileWatcher(): void {
    try {
        if (fs.existsSync(FILE_PATH)) {
            const watcher = fs.watch(FILE_PATH, (eventType) => {
                if (eventType === 'rename') {
                    // Atomic rename replaced the file (write_status uses temp+rename).
                    // Re-attach so Linux inode-based watchers stay live.
                    watcher.close();
                    fileWatcher = undefined;
                    setupFileWatcher();
                    updateStatusBar();
                } else if (eventType === 'change') {
                    updateStatusBar();
                }
            });
            watcher.on('error', () => {
                watcher.close();
                fileWatcher = undefined;
                setupFileWatcher();
            });
            fileWatcher = watcher;
            return;
        }

        const fileDir = path.dirname(FILE_PATH);
        const fileName = path.basename(FILE_PATH);
        const watcher = fs.watch(fileDir, (eventType, filename) => {
            if (filename !== fileName) {
                return;
            }
            if (eventType === 'rename') {
                watcher.close();
                fileWatcher = undefined;
                setupFileWatcher();
                updateStatusBar();
            } else if (eventType === 'change') {
                updateStatusBar();
            }
        });
        watcher.on('error', () => {
            watcher.close();
            fileWatcher = undefined;
        });
        fileWatcher = watcher;
    } catch (error) {
        console.error('Error setting up file watcher:', error);
        statusBarItem.text = '$(warning) Cannot watch file';
        statusBarItem.show();
    }
}

function updateStatusBar(): void {
    void updateStatusBarInner();
}

async function updateStatusBarInner(): Promise<void> {
    try {
        const data = await fs.promises.readFile(FILE_PATH, 'utf8');
        const content = data.trim();
        if (content) {
            currentStatusText = content;
            statusBarItem.text = content;
            statusBarItem.tooltip = await buildTooltip(content);
            statusBarItem.command = SHOW_FAIRSHARE_GRAPH_COMMAND;
        } else {
            currentStatusText = '';
            statusBarItem.text = '$(circle-outline) Empty';
            statusBarItem.tooltip = 'Status file is empty';
            statusBarItem.command = undefined;
        }
    } catch (error) {
        currentStatusText = '';
        statusBarItem.command = undefined;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            statusBarItem.text = '$(circle-slash) No Slurm status';
            statusBarItem.tooltip = `File not found: ${FILE_PATH}\n\nRun your slurm_monitor.sh script to create it. You can pass one or more cluster aliases.`;
        } else {
            const message = error instanceof Error ? error.message : String(error);
            console.error('Error reading file:', error);
            statusBarItem.text = '$(warning) Error reading file';
            statusBarItem.tooltip = `Error: ${message}`;
        }
    }
    statusBarItem.show();
}

async function buildTooltip(statusText: string): Promise<vscode.MarkdownString> {
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = true;
    tooltip.supportThemeIcons = true;

    const jobs = parseJobs(statusText);
    const historyRows = await readHistoryRows();
    const latestHistoryTimestamp = historyRows.length > 0
        ? formatTimestamp(historyRows[historyRows.length - 1].timestamp)
        : 'No fairshare samples yet';

    tooltip.appendMarkdown('### $(graph-line) HPC Usage Dashboard\n\n');
    tooltip.appendCodeblock(statusText, 'text');

    if (jobs.length > 0) {
        const stateCounts = new Map<string, number>();
        for (const job of jobs) {
            stateCounts.set(job.state, (stateCounts.get(job.state) ?? 0) + 1);
        }
        const summary = Array.from(stateCounts.entries())
            .map(([state, count]) => `${state}: ${count}`)
            .join(', ');
        tooltip.appendMarkdown(`**Jobs:** ${jobs.length} total`);
        if (summary) {
            tooltip.appendMarkdown(` (${summary})`);
        }
        tooltip.appendMarkdown('\n\n');

        const jobLines = jobs.map((job) => `${job.name} | ${job.state} | ${job.timer}`);
        tooltip.appendCodeblock(jobLines.join('\n'), 'text');
    } else {
        tooltip.appendMarkdown('**Jobs:** No active jobs\n\n');
    }

    tooltip.appendMarkdown('### $(pulse) Fairshare History\n\n');
    tooltip.appendMarkdown(`**Latest fairshare sample:** ${latestHistoryTimestamp}\n\n`);
    tooltip.appendCodeblock(buildFairshareSummary(historyRows), 'text');
    tooltip.appendMarkdown('\n[Open full status](command:slurmStatusBar.showFullStatus) | [Open HPC usage dashboard](command:slurmStatusBar.showFairshareGraph) | [Open fairshare history CSV](command:slurmStatusBar.openFairshareHistory)');

    return tooltip;
}

function parseJobs(statusText: string): JobEntry[] {
    const result: JobEntry[] = [];
    for (const raw of statusText.split(' | ')) {
        const segment = raw.trim();
        if (!segment) {
            continue;
        }
        if (STATUS_LABELS.some((label) => segment.startsWith(`${label}: `))) {
            continue;
        }
        const match = /^(.*?) \(([A-Z]+)\) (.+)$/.exec(segment);
        if (!match) {
            continue;
        }
        const [, name, state, timer] = match;
        result.push({ name, state, timer });
    }
    return result;
}

function buildFairshareSummary(historyRows: HistoryRow[]): string {
    const lines = ['Series         Latest  Delta   Trend'];

    for (const series of HISTORY_SERIES) {
        const values: number[] = [];
        for (const row of historyRows) {
            const value = row.values[series];
            if (value !== undefined) {
                values.push(value);
            }
        }
        const trimmed = values.slice(-MAX_TOOLTIP_HISTORY_POINTS);
        const label = SERIES_DISPLAY[series].padEnd(13);

        if (trimmed.length === 0) {
            lines.push(`${label} --      --      no data`);
            continue;
        }

        const latest = trimmed[trimmed.length - 1];
        const previous = trimmed.length > 1 ? trimmed[trimmed.length - 2] : undefined;
        const delta = previous === undefined ? '--' : formatDelta(latest - previous);
        const sparkline = buildSparkline(trimmed);

        lines.push(`${label} ${latest.toFixed(3).padEnd(6)} ${delta.padEnd(7)} ${sparkline}`);
    }

    return lines.join('\n');
}

function formatDelta(delta: number): string {
    const sign = delta >= 0 ? '+' : '';
    return `${sign}${delta.toFixed(3)}`;
}

function buildSparkline(values: number[]): string {
    if (values.length === 0) {
        return '';
    }
    if (values.length === 1) {
        return '█';
    }

    let min = values[0];
    let max = values[0];
    for (const value of values) {
        if (value < min) { min = value; }
        if (value > max) { max = value; }
    }
    if (min === max) {
        return '▅'.repeat(values.length);
    }

    const range = max - min;
    const lastBar = SPARKLINE_BARS.length - 1;
    let out = '';
    for (const value of values) {
        const normalized = (value - min) / range;
        const index = Math.max(0, Math.min(lastBar, Math.round(normalized * lastBar)));
        out += SPARKLINE_BARS[index];
    }
    return out;
}

function formatTimestamp(rawTimestamp: string): string {
    const timestamp = new Date(rawTimestamp);
    if (Number.isNaN(timestamp.getTime())) {
        return rawTimestamp;
    }
    return timestamp.toLocaleString();
}
