import * as vscode from 'vscode';
import * as fs from 'fs';
import {
    FAIRSHARE_HISTORY_PATH,
    JOB_HISTORY_PATH,
    JOB_SNAPSHOT_HISTORY_PATH,
    NODE_HISTORY_PATH,
    OPEN_FAIRSHARE_HISTORY_COMMAND,
    SHOW_FAIRSHARE_GRAPH_COMMAND,
    SHOW_FULL_STATUS_COMMAND,
} from './constants';
import {
    readHistoryRows,
    readJobHistory,
    readJobSnapshots,
    readNodeHistory,
} from './dataReaders';
import {
    createStatusBar,
    getCurrentStatusText,
    startMonitoring,
    stopMonitoring,
} from './statusBar';
import {
    buildDashboardPayload,
    buildDashboardShellHtml,
    DashboardPayload,
} from './dashboard/html';
import {
    computeRunningIntervals,
    deriveEvents,
    EventRecord,
    IntervalRecord,
} from './dashboard/derive';

let fairshareGraphPanel: vscode.WebviewPanel | undefined;

// The built payload is cached in-memory for the life of the extension host and
// served instantly on open (stale-while-revalidate). A deferred warm-up primes it
// shortly after activation so even the first open is fast.
let cachedPayload: DashboardPayload | undefined;
let cachedStat = '';
let buildInFlight: Promise<DashboardPayload> | undefined;
let warmupTimer: ReturnType<typeof setTimeout> | undefined;
const WARMUP_DELAY_MS = 4000;

// Deriving events + intervals means reading + walking the ~100 MB snapshot CSV,
// so cache the result and only redo it when the monitor has appended new rows.
let derivedCacheKey = '';
let derivedCache: { events: EventRecord[]; intervals: IntervalRecord[] } | undefined;

export function activate(context: vscode.ExtensionContext): void {
    console.log('HPC Usage Dashboard extension is now active!');

    createStatusBar(context);

    context.subscriptions.push(
        vscode.commands.registerCommand(SHOW_FULL_STATUS_COMMAND, showFullStatus),
        vscode.commands.registerCommand(SHOW_FAIRSHARE_GRAPH_COMMAND, () => showDashboard()),
        vscode.commands.registerCommand(OPEN_FAIRSHARE_HISTORY_COMMAND, openFairshareHistory),
    );

    startMonitoring();

    // Prime the dashboard cache off the critical path so the first open is fast.
    warmupTimer = setTimeout(() => {
        void refreshCache().catch((error) => console.error('Dashboard warm-up failed:', error));
    }, WARMUP_DELAY_MS);
}

export function deactivate(): void {
    if (warmupTimer) {
        clearTimeout(warmupTimer);
        warmupTimer = undefined;
    }
    stopMonitoring();
}

async function showFullStatus(): Promise<void> {
    const statusText = getCurrentStatusText();
    if (!statusText) {
        return;
    }
    const document = await vscode.workspace.openTextDocument({
        content: `${statusText}\n`,
        language: 'text',
    });
    await vscode.window.showTextDocument(document, {
        preview: true,
        preserveFocus: false,
    });
}

function statSignature(filePath: string): string {
    try {
        const stats = fs.statSync(filePath);
        return `${filePath}:${stats.size}:${stats.mtimeMs}`;
    } catch {
        return `${filePath}:missing`;
    }
}

function payloadStat(): string {
    return [
        FAIRSHARE_HISTORY_PATH,
        JOB_HISTORY_PATH,
        JOB_SNAPSHOT_HISTORY_PATH,
        NODE_HISTORY_PATH,
    ].map(statSignature).join('|');
}

// Rebuild the payload and cache it, coalescing concurrent callers onto one build.
// Posts the fresh payload to an open panel when done.
function refreshCache(): Promise<DashboardPayload> {
    if (buildInFlight) {
        return buildInFlight;
    }
    const statAtStart = payloadStat();
    const started = buildPayload()
        .then((payload) => {
            cachedPayload = payload;
            cachedStat = statAtStart;
            buildInFlight = undefined;
            if (fairshareGraphPanel) {
                void fairshareGraphPanel.webview.postMessage({ type: 'dashboard', payload });
            }
            return payload;
        })
        .catch((error) => {
            buildInFlight = undefined;
            throw error;
        });
    buildInFlight = started;
    return started;
}

async function buildPayload(): Promise<DashboardPayload> {
    const [historyRows, jobHistory, nodeHistory] = await Promise.all([
        readHistoryRows(),
        readJobHistory(),
        readNodeHistory(),
    ]);

    const cacheKey = `${statSignature(JOB_SNAPSHOT_HISTORY_PATH)}|${statSignature(JOB_HISTORY_PATH)}`;
    if (!derivedCache || derivedCacheKey !== cacheKey) {
        const jobSnapshots = await readJobSnapshots();
        derivedCache = {
            events: deriveEvents(jobSnapshots, jobHistory),
            intervals: computeRunningIntervals(jobSnapshots),
        };
        derivedCacheKey = cacheKey;
    }

    return buildDashboardPayload(
        historyRows,
        jobHistory,
        nodeHistory,
        derivedCache.events,
        derivedCache.intervals,
    );
}

function ensureDashboardPanel(): vscode.WebviewPanel {
    if (fairshareGraphPanel) {
        return fairshareGraphPanel;
    }

    const panel = vscode.window.createWebviewPanel(
        'slurmStatusBarFairshareGraph',
        'HPC Usage Dashboard',
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            enableFindWidget: true,
            retainContextWhenHidden: true,
        },
    );
    panel.webview.html = buildDashboardShellHtml();
    // The webview announces itself once its script is live; if a payload is
    // already cached by then, hand it over (covers the payload-ready-first race).
    panel.webview.onDidReceiveMessage((message) => {
        if (message && message.type === 'ready' && cachedPayload) {
            void panel.webview.postMessage({ type: 'dashboard', payload: cachedPayload });
        }
    });
    panel.onDidDispose(() => {
        fairshareGraphPanel = undefined;
    });
    fairshareGraphPanel = panel;
    return panel;
}

async function showDashboard(): Promise<void> {
    // Open the (static) shell right away so the panel appears instantly.
    const panel = ensureDashboardPanel();
    panel.reveal(vscode.ViewColumn.Active, false);

    // Serve the cached payload immediately (usually instant). It can be up to one
    // monitor cycle stale, so refresh in the background when the files have moved
    // on; refreshCache() posts the fresh payload to the panel when it finishes.
    if (cachedPayload) {
        void panel.webview.postMessage({ type: 'dashboard', payload: cachedPayload });
    }
    if (!cachedPayload || cachedStat !== payloadStat()) {
        void refreshCache().catch((error) => {
            console.error('Failed to build dashboard payload:', error);
            if (!cachedPayload) {
                void vscode.window.showErrorMessage('Failed to load HPC dashboard data.');
            }
        });
    }
}

async function openFairshareHistory(): Promise<void> {
    try {
        const document = await vscode.workspace.openTextDocument(
            vscode.Uri.file(FAIRSHARE_HISTORY_PATH),
        );
        await vscode.window.showTextDocument(document, {
            preview: true,
            preserveFocus: false,
        });
    } catch (error) {
        const message = error instanceof Error
            ? error.message
            : 'Fairshare history file is not available yet.';
        void vscode.window.showInformationMessage(message);
    }
}
