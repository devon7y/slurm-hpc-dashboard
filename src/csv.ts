import {
    HISTORY_CLUSTERS,
    HISTORY_SERIES,
    HistorySeriesKey,
} from './constants';
import type {
    HistoryRow,
    JobHistoryData,
    JobSnapshotRow,
} from './types';

// The monitor writes plain values (SLURM job names, numbers, ISO timestamps)
// with no embedded commas or quotes, so the overwhelming majority of rows can
// use a plain split — an order of magnitude faster than the char scanner over
// the ~725k-row snapshot file. Fall back to the robust parser only if a quote
// is present (i.e. a field that was actually escaped).
export function splitCsvRow(line: string): string[] {
    return line.indexOf('"') === -1 ? line.split(',') : parseCsvLine(line);
}

export function parseCsvLine(line: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '"') {
            if (inQuotes && line[index + 1] === '"') {
                current += '"';
                index += 1;
                continue;
            }
            inQuotes = !inQuotes;
            continue;
        }
        if (char === ',' && !inQuotes) {
            values.push(current);
            current = '';
            continue;
        }
        current += char;
    }

    values.push(current);
    return values;
}

export function parseMaybeNumber(value: string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function splitCsvLines(content: string): string[] {
    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

export function parseHistoryCsv(content: string): HistoryRow[] {
    const lines = splitCsvLines(content);
    if (lines.length < 2) {
        return [];
    }

    const header = parseCsvLine(lines[0]).map((column) => column.trim());
    const legacyHeader = ['timestamp', ...HISTORY_CLUSTERS];
    const isLegacy = header.length === legacyHeader.length
        && header.every((value, index) => value === legacyHeader[index]);

    const seriesSet = new Set<string>(HISTORY_SERIES);

    return lines.slice(1).map((line) => {
        const columns = splitCsvRow(line);
        const timestamp = columns[0] ?? '';
        const values: Partial<Record<HistorySeriesKey, number>> = {};

        if (isLegacy) {
            HISTORY_CLUSTERS.forEach((cluster, index) => {
                values[`${cluster}_gpu`] = parseMaybeNumber(columns[index + 1]);
            });
        } else {
            for (let index = 1; index < header.length; index += 1) {
                const column = header[index];
                if (seriesSet.has(column)) {
                    values[column as HistorySeriesKey] = parseMaybeNumber(columns[index]);
                }
            }
        }

        return { timestamp, values };
    });
}

export function parseJobHistoryCsv(content: string): JobHistoryData {
    const lines = splitCsvLines(content);
    if (lines.length < 2) {
        return { metricKeys: [], rows: [] };
    }

    const header = parseCsvLine(lines[0]).map((column) => column.trim());
    const metricKeys = header.slice(1);
    const rows = lines.slice(1).map((line) => {
        const columns = splitCsvRow(line);
        const values: Record<string, number | undefined> = {};
        for (let index = 0; index < metricKeys.length; index += 1) {
            values[metricKeys[index]] = parseMaybeNumber(columns[index + 1]);
        }
        return {
            timestamp: columns[0] ?? '',
            values,
        };
    });

    return { metricKeys, rows };
}

export function parseJobSnapshotCsv(content: string): JobSnapshotRow[] {
    const lines = splitCsvLines(content);
    if (lines.length < 2) {
        return [];
    }

    const header = parseCsvLine(lines[0]).map((column) => column.trim());
    const columnIndex = new Map<string, number>();
    header.forEach((column, index) => {
        columnIndex.set(column, index);
    });

    const readColumn = (columns: string[], key: string): string => {
        const index = columnIndex.get(key);
        return index === undefined ? '' : (columns[index] ?? '');
    };
    const normalizeText = (value: string): string => value.trim().replace(/^'+|'+$/g, '');

    return lines.slice(1).map((line) => {
        const columns = splitCsvRow(line);
        return {
            timestamp: normalizeText(readColumn(columns, 'timestamp')),
            remote: normalizeText(readColumn(columns, 'remote')),
            jobId: normalizeText(readColumn(columns, 'job_id')),
            name: normalizeText(readColumn(columns, 'name')),
            state: normalizeText(readColumn(columns, 'state')),
            elapsedHours: parseMaybeNumber(readColumn(columns, 'elapsed_hours')),
            remainingHours: parseMaybeNumber(readColumn(columns, 'remaining_hours')),
            timeLimitHours: parseMaybeNumber(readColumn(columns, 'time_limit_hours')),
            numNodes: parseMaybeNumber(readColumn(columns, 'num_nodes')),
            numCpus: parseMaybeNumber(readColumn(columns, 'num_cpus')),
            numGpus: parseMaybeNumber(readColumn(columns, 'num_gpus')),
            cpuHoursElapsed: parseMaybeNumber(readColumn(columns, 'cpu_hours_elapsed')),
            cpuHoursRemaining: parseMaybeNumber(readColumn(columns, 'cpu_hours_remaining')),
            cpuHoursLimit: parseMaybeNumber(readColumn(columns, 'cpu_hours_limit')),
            gpuHoursElapsed: parseMaybeNumber(readColumn(columns, 'gpu_hours_elapsed')),
            gpuHoursRemaining: parseMaybeNumber(readColumn(columns, 'gpu_hours_remaining')),
            gpuHoursLimit: parseMaybeNumber(readColumn(columns, 'gpu_hours_limit')),
        };
    });
}
