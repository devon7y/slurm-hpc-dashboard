import type { HistorySeriesKey } from './constants';

export interface JobEntry {
    name: string;
    state: string;
    timer: string;
    remote?: string;
}

export interface HistoryRow {
    timestamp: string;
    values: Partial<Record<HistorySeriesKey, number>>;
}

export interface JobHistoryRow {
    timestamp: string;
    values: Record<string, number | undefined>;
}

export interface JobHistoryData {
    metricKeys: string[];
    rows: JobHistoryRow[];
}

export interface JobSnapshotRow {
    timestamp: string;
    remote: string;
    jobId: string;
    name: string;
    state: string;
    elapsedHours?: number;
    remainingHours?: number;
    timeLimitHours?: number;
    numNodes?: number;
    numCpus?: number;
    numGpus?: number;
    cpuHoursElapsed?: number;
    cpuHoursRemaining?: number;
    cpuHoursLimit?: number;
    gpuHoursElapsed?: number;
    gpuHoursRemaining?: number;
    gpuHoursLimit?: number;
}
