import { HISTORY_CLUSTERS } from '../constants';
import type { JobHistoryData, JobSnapshotRow } from '../types';

// Host-side derivation of the two things the dashboard used to compute in the
// webview from the full 100 MB / 725k-row snapshot CSV: job events and running
// intervals. Doing this here means we ship the (small) derived results instead
// of every raw snapshot row, and lets us fix the O(n^2) that made loads crawl.

export interface EventRecord {
    type: 'submit' | 'start' | 'end' | 'queue_change';
    timestamp: string;
    remote: string;
    jobId?: string;
    name?: string;
    fromState?: string | null;
    toState?: string | null;
    numCpus?: number;
    numGpus?: number;
    elapsedHours?: number;
    remainingHours?: number;
    timeLimitHours?: number;
    gpuHoursRemaining?: number;
    note?: string;
    deltaJobs?: number;
    beforeJobs?: number;
    afterJobs?: number;
}

export interface IntervalRecord {
    remote: string;
    jobId: string;
    name: string;
    start: string;
    end: string;
}

export interface PackedRows {
    timestamps: string[];
    keys: string[];
    columns: Record<string, Array<number | null>>;
}

// Columnar packing: instead of an array of { timestamp, values: { key: n, ... } }
// objects (which repeats every key name on every row — the bulk of the old
// payload), ship parallel arrays. The webview rebuilds the row objects on load.
export function packRows(
    rows: Array<{ timestamp: string; values: Record<string, number | undefined> }>,
    keys: readonly string[],
): PackedRows {
    const timestamps: string[] = new Array(rows.length);
    const columns: Record<string, Array<number | null>> = {};
    for (const key of keys) {
        columns[key] = new Array(rows.length);
    }
    for (let index = 0; index < rows.length; index += 1) {
        timestamps[index] = rows[index].timestamp;
        const values = rows[index].values;
        for (const key of keys) {
            const value = values[key];
            columns[key][index] = typeof value === 'number' && Number.isFinite(value)
                ? value
                : null;
        }
    }
    return { timestamps, keys: [...keys], columns };
}

// Thin the metric-history rows sent to the webview to keep the payload small and
// fast to transfer/rebuild. Fairshare (the main chart) is kept at full resolution
// elsewhere; job/node history only feed overlays and stats, where coarser spacing
// is invisible. The first and last rows are always preserved so "current" values
// and the full time span stay exact.
export function downsampleRows<T>(rows: T[], maxRows: number): T[] {
    if (rows.length <= maxRows || maxRows < 2) {
        return rows;
    }
    const stride = Math.ceil(rows.length / maxRows);
    const result: T[] = [];
    for (let index = 0; index < rows.length; index += stride) {
        result.push(rows[index]);
    }
    const last = rows[rows.length - 1];
    if (result[result.length - 1] !== last) {
        result.push(last);
    }
    return result;
}

function toMs(timestamp: string): number {
    return new Date(timestamp).getTime();
}

// Ported from the old in-webview deriveEvents. The one behavioral change is the
// summary lookup: the original did summaryRows.find(...) inside a per-timestamp
// loop (O(n^2) — ~3.9 billion ops on the current dataset). This uses a Map.
export function deriveEvents(
    snapshots: JobSnapshotRow[],
    jobHistory: JobHistoryData,
): EventRecord[] {
    const snapshotsByTimestamp = new Map<number, JobSnapshotRow[]>();
    for (const row of snapshots) {
        const ms = toMs(row.timestamp);
        if (Number.isNaN(ms)) {
            continue;
        }
        let bucket = snapshotsByTimestamp.get(ms);
        if (!bucket) {
            bucket = [];
            snapshotsByTimestamp.set(ms, bucket);
        }
        bucket.push(row);
    }

    const summaryByTimestamp = new Map<number, Record<string, number | undefined>>();
    for (const row of jobHistory.rows) {
        const ms = toMs(row.timestamp);
        if (!Number.isNaN(ms)) {
            summaryByTimestamp.set(ms, row.values);
        }
    }

    const timeline = Array.from(summaryByTimestamp.keys()).sort((a, b) => a - b);
    let previousJobs = new Map<string, JobSnapshotRow>();
    let previousSummary: Record<string, number | undefined> | null = null;
    const events: EventRecord[] = [];

    for (const timestamp of timeline) {
        const iso = new Date(timestamp).toISOString();
        const currentJobs = new Map<string, JobSnapshotRow>();
        for (const row of snapshotsByTimestamp.get(timestamp) || []) {
            currentJobs.set(`${row.remote}:${row.jobId}`, row);
        }

        for (const [jobKey, job] of currentJobs.entries()) {
            const previous = previousJobs.get(jobKey);
            if (!previous) {
                events.push({
                    type: 'submit',
                    timestamp: iso,
                    remote: job.remote,
                    jobId: job.jobId,
                    name: job.name,
                    fromState: null,
                    toState: job.state,
                    numCpus: job.numCpus,
                    numGpus: job.numGpus,
                    elapsedHours: job.elapsedHours,
                    remainingHours: job.remainingHours,
                    timeLimitHours: job.timeLimitHours,
                    gpuHoursRemaining: job.gpuHoursRemaining,
                    note: 'Job first appeared in active queue snapshots.',
                });
                if (job.state === 'R') {
                    events.push({
                        type: 'start',
                        timestamp: iso,
                        remote: job.remote,
                        jobId: job.jobId,
                        name: job.name,
                        fromState: null,
                        toState: job.state,
                        numCpus: job.numCpus,
                        numGpus: job.numGpus,
                        elapsedHours: job.elapsedHours,
                        remainingHours: job.remainingHours,
                        timeLimitHours: job.timeLimitHours,
                        gpuHoursRemaining: job.gpuHoursRemaining,
                        note: 'Job appeared already running.',
                    });
                }
                continue;
            }

            if (previous.state !== job.state && job.state === 'R') {
                events.push({
                    type: 'start',
                    timestamp: iso,
                    remote: job.remote,
                    jobId: job.jobId,
                    name: job.name,
                    fromState: previous.state,
                    toState: job.state,
                    numCpus: job.numCpus,
                    numGpus: job.numGpus,
                    elapsedHours: job.elapsedHours,
                    remainingHours: job.remainingHours,
                    timeLimitHours: job.timeLimitHours,
                    gpuHoursRemaining: job.gpuHoursRemaining,
                    note: `State changed ${previous.state} → ${job.state}.`,
                });
            }
        }

        for (const [jobKey, previous] of previousJobs.entries()) {
            if (!currentJobs.has(jobKey)) {
                events.push({
                    type: 'end',
                    timestamp: iso,
                    remote: previous.remote,
                    jobId: previous.jobId,
                    name: previous.name,
                    fromState: previous.state,
                    toState: null,
                    numCpus: previous.numCpus,
                    numGpus: previous.numGpus,
                    elapsedHours: previous.elapsedHours,
                    remainingHours: previous.remainingHours,
                    timeLimitHours: previous.timeLimitHours,
                    gpuHoursRemaining: previous.gpuHoursRemaining,
                    note: 'Job disappeared from active queue snapshots.',
                });
            }
        }

        const currentSummary = summaryByTimestamp.get(timestamp) || null;
        if (previousSummary && currentSummary) {
            const totalDelta = (currentSummary.total_jobs || 0) - (previousSummary.total_jobs || 0);
            if (Math.abs(totalDelta) >= 2) {
                events.push({
                    type: 'queue_change',
                    timestamp: iso,
                    remote: 'all',
                    note: `Total jobs changed by ${totalDelta >= 0 ? '+' : ''}${totalDelta}.`,
                    deltaJobs: totalDelta,
                    beforeJobs: previousSummary.total_jobs || 0,
                    afterJobs: currentSummary.total_jobs || 0,
                });
            }

            for (const cluster of HISTORY_CLUSTERS) {
                const key = `${cluster}_jobs`;
                const before = previousSummary[key] || 0;
                const after = currentSummary[key] || 0;
                const delta = after - before;
                if (Math.abs(delta) >= 2) {
                    events.push({
                        type: 'queue_change',
                        timestamp: iso,
                        remote: cluster,
                        note: `${cluster} jobs changed by ${delta >= 0 ? '+' : ''}${delta}.`,
                        deltaJobs: delta,
                        beforeJobs: before,
                        afterJobs: after,
                    });
                }
            }
        }

        previousJobs = currentJobs;
        previousSummary = currentSummary;
    }

    return events;
}

// Ported from the old in-webview runningIntervalsForRange, but computed once over
// all history with no range/cluster filter. The webview clips to the visible
// range, filters by cluster, and lays the spans into lanes as before.
export function computeRunningIntervals(snapshots: JobSnapshotRow[]): IntervalRecord[] {
    const snapshotsByTimestamp = new Map<number, JobSnapshotRow[]>();
    for (const snapshot of snapshots) {
        const ms = toMs(snapshot.timestamp);
        if (Number.isNaN(ms)) {
            continue;
        }
        let bucket = snapshotsByTimestamp.get(ms);
        if (!bucket) {
            bucket = [];
            snapshotsByTimestamp.set(ms, bucket);
        }
        bucket.push(snapshot);
    }

    const timeline = Array.from(snapshotsByTimestamp.keys()).sort((a, b) => a - b);
    if (timeline.length === 0) {
        return [];
    }
    const lastMs = timeline[timeline.length - 1];

    const activeByJob = new Map<string, { remote: string; jobId: string; name: string; start: number }>();
    const intervals: IntervalRecord[] = [];

    for (const timestamp of timeline) {
        const runningRows = (snapshotsByTimestamp.get(timestamp) || []).filter((row) => row.state === 'R');
        const runningKeys = new Set<string>();

        for (const row of runningRows) {
            const jobKey = `${row.remote}:${row.jobId}`;
            runningKeys.add(jobKey);
            if (!activeByJob.has(jobKey)) {
                activeByJob.set(jobKey, {
                    remote: row.remote,
                    jobId: row.jobId,
                    name: row.name,
                    start: timestamp,
                });
            }
        }

        for (const [jobKey, span] of activeByJob.entries()) {
            if (runningKeys.has(jobKey)) {
                continue;
            }
            intervals.push({
                remote: span.remote,
                jobId: span.jobId,
                name: span.name,
                start: new Date(span.start).toISOString(),
                end: new Date(timestamp).toISOString(),
            });
            activeByJob.delete(jobKey);
        }
    }

    for (const span of activeByJob.values()) {
        intervals.push({
            remote: span.remote,
            jobId: span.jobId,
            name: span.name,
            start: new Date(span.start).toISOString(),
            end: new Date(lastMs).toISOString(),
        });
    }

    return intervals;
}
