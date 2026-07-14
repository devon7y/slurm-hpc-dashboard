export const DASHBOARD_SCRIPT = `
        const vscode = acquireVsCodeApi();
        // Data-derived state is filled in by applyPayload() once the extension
        // host streams the dashboard payload in via postMessage.
        let HISTORY_SERIES = [];
        let SERIES_LABELS = {};
        let SERIES_COLORS = {};
        let SERIES_DASHARRAY = {};
        let CLUSTERS = [];
        let JOB_METRIC_KEYS = [];
        let JOB_METRIC_LABELS = {};
        let NODE_METRIC_KEYS = [];
        let NODE_METRIC_LABELS = {};
        const svg = document.getElementById('chart');
        const tooltip = document.getElementById('chartTooltip');
        const legend = document.getElementById('legend');
        const metrics = document.getElementById('metrics');
        const selectionSummary = document.getElementById('selectionSummary');
        const jobStats = document.getElementById('jobStats');
        const efficiencyView = document.getElementById('efficiencyView');
        const lagCorrelationView = document.getElementById('lagCorrelationView');
        const eventTableView = document.getElementById('eventTableView');
        const startInput = document.getElementById('startDate');
        const endInput = document.getElementById('endDate');
        const toggleCpu = document.getElementById('toggleCpu');
        const toggleGpu = document.getElementById('toggleGpu');
        const aggregationSelect = document.getElementById('aggregationSelect');
        const clusterSelect = document.getElementById('clusterSelect');
        const jobMetricSelect = document.getElementById('jobMetricSelect');
        const clearSelectionButton = document.getElementById('clearSelection');
        const presetButtons = Array.from(document.querySelectorAll('.preset-button'));
        const CHART = {
            width: 1120,
            height: 620,
            padding: { top: 28, right: 28, bottom: 72, left: 72 },
        };
        const MAX_POLYLINE_POINTS = 2000;
        let currentRows = [];
        let currentJobRows = [];
        let currentNodeRows = [];
        let currentSeries = [];
        let currentPlotWidth = 0;
        let currentXForIndex = () => CHART.padding.left;
        let currentSelectionRange = null;
        let isDragging = false;
        let dragAnchorIndex = null;
        let dragCurrentIndex = null;
        let currentHoveredIndex = null;
        let currentHoverUpdater = null;
        let currentSelectionHoverUpdater = null;
        let currentHideHover = null;
        let pendingRenderFrame = null;
        let pendingDeferredTimer = null;
        const AGGREGATION_BUCKETS = {
            raw: 0,
            '15m': 15 * 60 * 1000,
            '1h': 60 * 60 * 1000,
            '6h': 6 * 60 * 60 * 1000,
        };
        const EVENT_LABELS = {
            submit: 'Submit',
            start: 'Start',
            end: 'End',
            queue_change: 'Queue \\u0394',
        };
        let JOB_METRIC_KEY_SET = new Set();
        let NODE_METRIC_KEY_SET = new Set();

        // Populated by applyPayload(). Events and running intervals are derived
        // on the extension host (from the raw snapshot CSV) and arrive ready to
        // use, so the webview never touches the 100 MB / 725k-row snapshot data.
        let allRows = [];
        let allJobRows = [];
        let allNodeRows = [];
        let allEvents = [];
        let allIntervals = [];
        let OVERLAY_METRIC_KEYS = [];
        let OVERLAY_METRIC_LABELS = {};

        function binarySearchNearest(sortedRows, targetMs) {
            if (sortedRows.length === 0) {
                return null;
            }
            let lo = 0;
            let hi = sortedRows.length - 1;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (sortedRows[mid].date.getTime() < targetMs) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            let best = lo;
            if (lo > 0) {
                const deltaLo = Math.abs(sortedRows[lo].date.getTime() - targetMs);
                const deltaPrev = Math.abs(sortedRows[lo - 1].date.getTime() - targetMs);
                if (deltaPrev < deltaLo) {
                    best = lo - 1;
                }
            }
            const delta = Math.abs(sortedRows[best].date.getTime() - targetMs);
            return delta <= 120000 ? sortedRows[best] : null;
        }

        function binarySearchNearestIndex(sortedRows, targetMs) {
            if (sortedRows.length === 0) {
                return 0;
            }
            let lo = 0;
            let hi = sortedRows.length - 1;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (sortedRows[mid].date.getTime() < targetMs) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            if (lo > 0) {
                const deltaLo = Math.abs(sortedRows[lo].date.getTime() - targetMs);
                const deltaPrev = Math.abs(sortedRows[lo - 1].date.getTime() - targetMs);
                if (deltaPrev < deltaLo) {
                    return lo - 1;
                }
            }
            return lo;
        }

        function decimatePoints(points, maxPoints) {
            if (points.length <= maxPoints) {
                return points;
            }
            const result = [points[0]];
            const bucketSize = (points.length - 2) / (maxPoints - 2);
            let prevSelected = points[0];
            for (let i = 1; i < maxPoints - 1; i++) {
                const bucketStart = Math.floor((i - 1) * bucketSize) + 1;
                const bucketEnd = Math.min(Math.floor(i * bucketSize) + 1, points.length - 1);
                const nextBucketStart = Math.min(Math.floor(i * bucketSize) + 1, points.length - 1);
                const nextBucketEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, points.length - 1);
                let avgX = 0;
                let avgY = 0;
                let count = 0;
                for (let j = nextBucketStart; j <= nextBucketEnd; j++) {
                    avgX += points[j].rowIndex;
                    avgY += points[j].value;
                    count++;
                }
                avgX /= count;
                avgY /= count;
                let bestArea = -1;
                let bestIdx = bucketStart;
                for (let j = bucketStart; j <= bucketEnd; j++) {
                    const area = Math.abs(
                        (prevSelected.rowIndex - avgX) * (points[j].value - prevSelected.value)
                        - (prevSelected.rowIndex - points[j].rowIndex) * (avgY - prevSelected.value)
                    );
                    if (area > bestArea) {
                        bestArea = area;
                        bestIdx = j;
                    }
                }
                result.push(points[bestIdx]);
                prevSelected = points[bestIdx];
            }
            result.push(points[points.length - 1]);
            return result;
        }

        function minMaxValues(values) {
            if (values.length === 0) {
                return { min: 0, max: 0 };
            }
            let min = values[0];
            let max = values[0];
            for (let i = 1; i < values.length; i++) {
                const v = values[i];
                if (v < min) { min = v; }
                if (v > max) { max = v; }
            }
            return { min, max };
        }

        function toInputValue(date) {
            const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
            return local.toISOString().slice(0, 16);
        }

        function formatTime(date) {
            return date.toLocaleString();
        }

        function formatValue(value) {
            return typeof value === 'number' ? value.toFixed(3) : '--';
        }

        function formatDelta(value) {
            if (typeof value !== 'number' || Number.isNaN(value)) {
                return '--';
            }
            const sign = value >= 0 ? '+' : '';
            return \`\${sign}\${value.toFixed(3)}\`;
        }

        function formatDuration(startDate, endDate) {
            const diffMs = Math.max(0, endDate.getTime() - startDate.getTime());
            const totalMinutes = Math.round(diffMs / 60000);
            const days = Math.floor(totalMinutes / (60 * 24));
            const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
            const minutes = totalMinutes % 60;
            if (days > 0) {
                return \`\${days}d \${hours}h \${minutes}m\`;
            }
            if (hours > 0) {
                return \`\${hours}h \${minutes}m\`;
            }
            return \`\${minutes}m\`;
        }

        function formatJobMetricValue(metricKey, value) {
            if (typeof value !== 'number' || Number.isNaN(value)) {
                return '--';
            }
            if (metricKey.includes('hours')) {
                return \`\${value.toFixed(3)}h\`;
            }
            return Number.isInteger(value) ? String(value) : value.toFixed(3);
        }

        function formatJobMetricDelta(metricKey, value) {
            if (typeof value !== 'number' || Number.isNaN(value)) {
                return '--';
            }
            if (metricKey.includes('hours')) {
                return \`\${value >= 0 ? '+' : ''}\${value.toFixed(3)}h\`;
            }
            return Number.isInteger(value)
                ? \`\${value >= 0 ? '+' : ''}\${Math.trunc(value)}\`
                : \`\${value >= 0 ? '+' : ''}\${value.toFixed(3)}\`;
        }

        function selectedJobMetric() {
            return jobMetricSelect.value || 'none';
        }

        function findNearestJobRow(date) {
            const sourceRows = currentJobRows.length > 0 ? currentJobRows : allJobRows;
            return binarySearchNearest(sourceRows, date.getTime());
        }

        function findNearestNodeRow(date) {
            const sourceRows = currentNodeRows.length > 0 ? currentNodeRows : allNodeRows;
            return binarySearchNearest(sourceRows, date.getTime());
        }

        function overlayMetricValueForRow(fairshareRow, metricKey) {
            if (!metricKey || metricKey === 'none') {
                return undefined;
            }
            if (JOB_METRIC_KEY_SET.has(metricKey)) {
                const jobRow = findNearestJobRow(fairshareRow.date);
                return jobRow ? jobRow.values[metricKey] : undefined;
            }
            if (NODE_METRIC_KEY_SET.has(metricKey)) {
                const nodeRow = findNearestNodeRow(fairshareRow.date);
                return nodeRow ? nodeRow.values[metricKey] : undefined;
            }
            return undefined;
        }

        function jobMetricValueForRow(fairshareRow, metricKey) {
            if (!JOB_METRIC_KEY_SET.has(metricKey)) {
                return undefined;
            }
            const jobRow = findNearestJobRow(fairshareRow.date);
            return jobRow ? jobRow.values[metricKey] : undefined;
        }

        function initializeJobMetricSelect() {
            const options = ['<option value="none">No overlay metric</option>']
                .concat(OVERLAY_METRIC_KEYS.map((key) => \`<option value="\${key}">\${OVERLAY_METRIC_LABELS[key] || key}</option>\`));
            jobMetricSelect.innerHTML = options.join('');
            jobMetricSelect.value = 'none';
        }

        function selectedCluster() {
            return clusterSelect.value || 'all';
        }

        function selectedAggregationBucketMs() {
            return AGGREGATION_BUCKETS[aggregationSelect.value] || 0;
        }

        function rangeBounds() {
            return {
                start: startInput.value ? new Date(startInput.value) : null,
                end: endInput.value ? new Date(endInput.value) : null,
            };
        }

        function filterRowsByRange(rows) {
            const { start, end } = rangeBounds();
            if (!start && !end) {
                return rows;
            }
            const startMs = start ? start.getTime() : -Infinity;
            const endMs = end ? end.getTime() : Infinity;
            let lo = 0;
            let hi = rows.length;
            if (start) {
                let a = 0;
                let b = rows.length;
                while (a < b) {
                    const mid = (a + b) >>> 1;
                    if (rows[mid].date.getTime() < startMs) {
                        a = mid + 1;
                    } else {
                        b = mid;
                    }
                }
                lo = a;
            }
            if (end) {
                let a = lo;
                let b = rows.length;
                while (a < b) {
                    const mid = (a + b) >>> 1;
                    if (rows[mid].date.getTime() <= endMs) {
                        a = mid + 1;
                    } else {
                        b = mid;
                    }
                }
                hi = a;
            }
            return rows.slice(lo, hi);
        }

        function bucketStartMs(date, bucketMs) {
            if (bucketMs <= 0) {
                return date.getTime();
            }
            return Math.floor(date.getTime() / bucketMs) * bucketMs;
        }

        function aggregateFairshareRows(rows, bucketMs) {
            if (bucketMs <= 0 || rows.length <= 1) {
                return rows;
            }

            const buckets = new Map();
            for (const row of rows) {
                const bucketKey = bucketStartMs(row.date, bucketMs);
                let bucket = buckets.get(bucketKey);
                if (!bucket) {
                    bucket = {
                        bucketKey,
                        countBySeries: {},
                        sumBySeries: {},
                    };
                    buckets.set(bucketKey, bucket);
                }
                for (const seriesKey of HISTORY_SERIES) {
                    const value = row.values[seriesKey];
                    if (typeof value !== 'number') {
                        continue;
                    }
                    bucket.sumBySeries[seriesKey] = (bucket.sumBySeries[seriesKey] || 0) + value;
                    bucket.countBySeries[seriesKey] = (bucket.countBySeries[seriesKey] || 0) + 1;
                }
            }

            return Array.from(buckets.values())
                .sort((a, b) => a.bucketKey - b.bucketKey)
                .map((bucket) => {
                    const bucketEnd = bucket.bucketKey + bucketMs;
                    const values = {};
                    for (const seriesKey of HISTORY_SERIES) {
                        if (bucket.countBySeries[seriesKey]) {
                            values[seriesKey] = bucket.sumBySeries[seriesKey] / bucket.countBySeries[seriesKey];
                        }
                    }
                    return {
                        timestamp: new Date(bucketEnd).toISOString(),
                        date: new Date(bucketEnd),
                        bucketStart: new Date(bucket.bucketKey),
                        bucketEnd: new Date(bucketEnd),
                        values,
                    };
                });
        }

        function aggregateGenericRows(rows, bucketMs, metricKeys) {
            if (bucketMs <= 0 || rows.length <= 1) {
                return rows;
            }

            const buckets = new Map();
            for (const row of rows) {
                const bucketKey = bucketStartMs(row.date, bucketMs);
                let bucket = buckets.get(bucketKey);
                if (!bucket) {
                    bucket = {
                        bucketKey,
                        sums: {},
                        counts: {},
                    };
                    buckets.set(bucketKey, bucket);
                }
                for (const key of metricKeys) {
                    const value = row.values[key];
                    if (typeof value !== 'number') {
                        continue;
                    }
                    bucket.sums[key] = (bucket.sums[key] || 0) + value;
                    bucket.counts[key] = (bucket.counts[key] || 0) + 1;
                }
            }

            return Array.from(buckets.values())
                .sort((a, b) => a.bucketKey - b.bucketKey)
                .map((bucket) => {
                    const bucketEnd = bucket.bucketKey + bucketMs;
                    const values = {};
                    for (const key of metricKeys) {
                        if (bucket.counts[key]) {
                            values[key] = bucket.sums[key] / bucket.counts[key];
                        }
                    }
                    return {
                        timestamp: new Date(bucketEnd).toISOString(),
                        date: new Date(bucketEnd),
                        bucketStart: new Date(bucket.bucketKey),
                        bucketEnd: new Date(bucketEnd),
                        values,
                    };
                });
        }

        function currentRangeRows() {
            return aggregateFairshareRows(filterRowsByRange(allRows), selectedAggregationBucketMs());
        }

        function currentRangeJobRows() {
            return aggregateGenericRows(filterRowsByRange(allJobRows), selectedAggregationBucketMs(), JOB_METRIC_KEYS);
        }

        function currentRangeNodeRows() {
            return aggregateGenericRows(filterRowsByRange(allNodeRows), selectedAggregationBucketMs(), NODE_METRIC_KEYS);
        }

        function metricForSeries(seriesKey) {
            return seriesKey.endsWith('_cpu') ? 'cpu' : 'gpu';
        }

        function visibleSeriesKeys() {
            const cluster = selectedCluster();
            return HISTORY_SERIES.filter((seriesKey) => {
                const metric = metricForSeries(seriesKey);
                const metricVisible = (metric === 'cpu' && toggleCpu.checked) || (metric === 'gpu' && toggleGpu.checked);
                const clusterVisible = cluster === 'all' || seriesKey.startsWith(\`\${cluster}_\`);
                return metricVisible && clusterVisible;
            });
        }

        function latestValueForSeries(rows, seriesKey) {
            for (let i = rows.length - 1; i >= 0; i--) {
                const value = rows[i].values[seriesKey];
                if (typeof value === 'number') {
                    return value;
                }
            }
            return null;
        }

        function updateLegend(rows, activeKeys) {
            const sourceRows = rows.length > 0 ? rows : allRows;
            legend.innerHTML = activeKeys.map((seriesKey) => {
                const latest = latestValueForSeries(sourceRows, seriesKey);
                const dashStyle = SERIES_DASHARRAY[seriesKey] ? 'dashed' : 'solid';
                return \`
                    <div class="legend-item">
                        <span class="legend-line" style="color:\${SERIES_COLORS[seriesKey]}; border-top-style:\${dashStyle};"></span>
                        <span class="legend-label">\${SERIES_LABELS[seriesKey]}</span>
                        <span class="legend-value">\${latest === null ? '--' : latest.toFixed(3)}</span>
                    </div>
                \`;
            }).join('');
        }

        function clusterMetricKey(clusterKey, suffix) {
            return \`\${clusterKey}_\${suffix}\`;
        }

        function eventsClusterLabel(remote) {
            if (!remote || remote === 'all') {
                return 'All';
            }
            const match = CLUSTERS.find((cluster) => cluster.cluster === remote);
            return match ? match.label : remote;
        }

        function filteredEventsForRange(startDate, endDate) {
            const cluster = selectedCluster();
            const startMs = startDate.getTime();
            const endMs = endDate.getTime();
            const result = [];
            for (const event of allEvents) {
                const t = event.date.getTime();
                if (t < startMs) { continue; }
                if (t > endMs) { break; }
                if (cluster !== 'all' && event.remote !== cluster) { continue; }
                result.push(event);
            }
            return result;
        }

        // Intervals are precomputed on the host over all history; here we just
        // filter to the selected cluster and clip each span to the visible range.
        function runningIntervalsForRange(startDate, endDate) {
            const cluster = selectedCluster();
            const startMs = startDate.getTime();
            const endMs = endDate.getTime();
            const result = [];
            for (const interval of allIntervals) {
                if (cluster !== 'all' && interval.remote !== cluster) {
                    continue;
                }
                if (interval.start.getTime() > endMs || interval.end.getTime() < startMs) {
                    continue;
                }
                const start = interval.start.getTime() < startMs ? startDate : interval.start;
                const end = interval.end.getTime() > endMs ? endDate : interval.end;
                if (end.getTime() > start.getTime()) {
                    result.push({
                        remote: interval.remote,
                        jobId: interval.jobId,
                        name: interval.name,
                        start,
                        end,
                    });
                }
            }
            return result;
        }

        function layoutIntervalsIntoLanes(intervals) {
            const sorted = [...intervals].sort((left, right) => {
                const delta = left.start.getTime() - right.start.getTime();
                if (delta !== 0) {
                    return delta;
                }
                return left.end.getTime() - right.end.getTime();
            });

            const laneEndTimes = [];
            return sorted.map((interval) => {
                const startMs = interval.start.getTime();
                const endMs = interval.end.getTime();
                let laneIndex = laneEndTimes.findIndex((laneEndMs) => laneEndMs <= startMs);
                if (laneIndex === -1) {
                    laneIndex = laneEndTimes.length;
                    laneEndTimes.push(endMs);
                } else {
                    laneEndTimes[laneIndex] = endMs;
                }
                return {
                    ...interval,
                    laneIndex,
                };
            });
        }

        function rowForSelectionRange(rows) {
            const selection = displayedSelection();
            if (selection && rows[selection.startIndex] && rows[selection.endIndex]) {
                return {
                    startRow: rows[selection.startIndex],
                    endRow: rows[selection.endIndex],
                };
            }
            return rows.length > 0
                ? {
                    startRow: rows[0],
                    endRow: rows[rows.length - 1],
                }
                : null;
        }

        function uniqueJobsInEvents(events, cluster) {
            const identifiers = new Set();
            for (const event of events) {
                if (!event.jobId || !event.remote) {
                    continue;
                }
                if (cluster !== 'all' && event.remote !== cluster) {
                    continue;
                }
                identifiers.add(\`\${event.remote}:\${event.jobId}\`);
            }
            return identifiers.size;
        }

        function formatEventType(type) {
            return EVENT_LABELS[type] || type;
        }

        function eventAccentColor(event) {
            if (!event.remote || event.remote === 'all') {
                return '#bfc7d5';
            }
            const clusterKey = \`\${event.remote}_gpu\`;
            return SERIES_COLORS[clusterKey] || '#bfc7d5';
        }

        function eventPillStyle(event) {
            const color = eventAccentColor(event);
            return \`color:\${color}; border-color:\${color}; background:\${color}22;\`;
        }

        function eventShortSymbol(type) {
            if (type === 'submit') {
                return '+';
            }
            if (type === 'start') {
                return '>';
            }
            if (type === 'end') {
                return 'x';
            }
            return '~';
        }

        function formatHoursValue(value) {
            return typeof value === 'number' ? \`\${value.toFixed(2)}h\` : '--';
        }

        function displayedSelection() {
            if (isDragging && dragAnchorIndex !== null && dragCurrentIndex !== null) {
                return {
                    startIndex: Math.min(dragAnchorIndex, dragCurrentIndex),
                    endIndex: Math.max(dragAnchorIndex, dragCurrentIndex),
                };
            }
            return currentSelectionRange;
        }

        function clearSelection() {
            currentSelectionRange = null;
            isDragging = false;
            dragAnchorIndex = null;
            dragCurrentIndex = null;
            currentHoveredIndex = null;
            renderSelectionVisual();
            renderSelectionSummary();
            renderJobStats(currentRows);
        }

        function setActivePreset(range) {
            presetButtons.forEach((button) => {
                button.classList.toggle('active', button.dataset.range === range);
            });
        }

        function applyPreset(range) {
            if (allRows.length === 0) {
                return;
            }
            setActivePreset(range);
            const lastDate = allRows[allRows.length - 1].date;
            if (range === 'all') {
                startInput.value = '';
                endInput.value = '';
                clearSelection();
                scheduleRender();
                return;
            }
            const durationMap = {
                '1d': 24 * 60 * 60 * 1000,
                '7d': 7 * 24 * 60 * 60 * 1000,
                '30d': 30 * 24 * 60 * 60 * 1000,
                '90d': 90 * 24 * 60 * 60 * 1000,
                '1y': 365 * 24 * 60 * 60 * 1000,
            };
            const duration = durationMap[range];
            const startDate = new Date(lastDate.getTime() - duration);
            startInput.value = toInputValue(startDate);
            endInput.value = toInputValue(lastDate);
            clearSelection();
            scheduleRender();
        }

        function rowIndexFromClientX(clientX) {
            if (currentRows.length <= 1) {
                return 0;
            }
            const rect = svg.getBoundingClientRect();
            const relativeX = clientX - rect.left;
            const chartX = (relativeX / rect.width) * CHART.width;
            const clampedX = Math.max(CHART.padding.left, Math.min(CHART.width - CHART.padding.right, chartX));
            const normalized = currentPlotWidth === 0 ? 0 : (clampedX - CHART.padding.left) / currentPlotWidth;
            return Math.max(0, Math.min(currentRows.length - 1, Math.round(normalized * (currentRows.length - 1))));
        }

        function renderSelectionVisual() {
            const selectionRect = document.getElementById('selectionRect');
            if (!selectionRect || currentRows.length === 0) {
                return;
            }
            const selection = displayedSelection();
            if (!selection) {
                selectionRect.setAttribute('opacity', '0');
                return;
            }

            let left = currentXForIndex(selection.startIndex);
            let right = currentXForIndex(selection.endIndex);
            if (currentRows.length === 1) {
                left = CHART.padding.left;
                right = CHART.width - CHART.padding.right;
            }

            selectionRect.setAttribute('x', String(Math.min(left, right)));
            selectionRect.setAttribute('y', String(CHART.padding.top));
            selectionRect.setAttribute('width', String(Math.max(3, Math.abs(right - left))));
            selectionRect.setAttribute('height', String(CHART.height - CHART.padding.top - CHART.padding.bottom));
            selectionRect.setAttribute('opacity', '0.14');
        }

        function renderSelectionSummary() {
            const selection = displayedSelection();
            const activeKeys = visibleSeriesKeys();
            if (!selection || currentRows.length === 0) {
                selectionSummary.innerHTML = '<div class="selection-header">Selection</div><div class="selection-subtle">Drag across the graph to measure net fairshare change over a specific time range.</div>';
                return;
            }

            const startRow = currentRows[selection.startIndex];
            const endRow = currentRows[selection.endIndex];
            const cards = CLUSTERS.map((cluster) => {
                const parts = [];
                for (const seriesKey of [cluster.cpu, cluster.gpu]) {
                    if (!activeKeys.includes(seriesKey)) {
                        continue;
                    }
                    const startValue = startRow.values[seriesKey];
                    const endValue = endRow.values[seriesKey];
                    if (typeof startValue !== 'number' || typeof endValue !== 'number') {
                        continue;
                    }
                    const metricLabel = seriesKey.endsWith('_cpu') ? 'CPU' : 'GPU';
                    parts.push(\`
                        <div class="selection-metric">
                            <span>\${metricLabel}</span>
                            <strong>\${formatDelta(endValue - startValue)}</strong>
                            <span>\${startValue.toFixed(3)} \\u2192 \${endValue.toFixed(3)}</span>
                        </div>
                    \`);
                }
                if (parts.length === 0) {
                    return '';
                }
                return \`
                    <div class="selection-card">
                        <div class="selection-card-title">\${cluster.label}</div>
                        \${parts.join('')}
                    </div>
                \`;
            }).join('');

            selectionSummary.innerHTML = \`
                <div class="selection-header">Selection: \${formatTime(startRow.date)} to \${formatTime(endRow.date)}</div>
                <div class="selection-subtle">Duration: \${formatDuration(startRow.date, endRow.date)} | Samples: \${selection.endIndex - selection.startIndex + 1}</div>
                <div class="selection-grid">\${cards || '<div class="empty">No visible fairshare values in this selection.</div>'}</div>
            \`;
        }

        function renderJobStats(rows) {
            const metricKey = selectedJobMetric();
            const latestFairshareRow = rows.length > 0 ? rows[rows.length - 1] : allRows[allRows.length - 1];
            const latestJobRow = latestFairshareRow ? findNearestJobRow(latestFairshareRow.date) : null;

            if (!latestJobRow) {
                jobStats.innerHTML = '<div class="selection-header">Job Statistics</div><div class="selection-subtle">No aligned job-history samples are available for the current range.</div>';
                return;
            }

            const selection = displayedSelection();
            const selectedStart = selection && currentRows[selection.startIndex]
                ? findNearestJobRow(currentRows[selection.startIndex].date)
                : null;
            const selectedEnd = selection && currentRows[selection.endIndex]
                ? findNearestJobRow(currentRows[selection.endIndex].date)
                : null;
            const selectionMetricDelta = (
                selection
                && metricKey !== 'none'
                && currentRows[selection.startIndex]
                && currentRows[selection.endIndex]
                && typeof overlayMetricValueForRow(currentRows[selection.startIndex], metricKey) === 'number'
                && typeof overlayMetricValueForRow(currentRows[selection.endIndex], metricKey) === 'number'
            )
                ? Number(overlayMetricValueForRow(currentRows[selection.endIndex], metricKey))
                    - Number(overlayMetricValueForRow(currentRows[selection.startIndex], metricKey))
                : undefined;

            const selectionDeltaForMetric = (key) => {
                if (!selection || !selectedStart || !selectedEnd) {
                    return undefined;
                }
                const startValue = selectedStart.values[key];
                const endValue = selectedEnd.values[key];
                if (typeof startValue !== 'number' || typeof endValue !== 'number') {
                    return undefined;
                }
                return Number(endValue) - Number(startValue);
            };

            const formatStatsValue = (key) => {
                const current = formatJobMetricValue(key, latestJobRow.values[key]);
                const delta = selectionDeltaForMetric(key);
                if (delta === undefined) {
                    return current;
                }
                return \`\${current} <span class="stats-delta">(\${formatJobMetricDelta(key, delta)})</span>\`;
            };

            const clusterCards = CLUSTERS.map((cluster) => ({
                title: \`\${cluster.label} Jobs\`,
                rows: [
                    [JOB_METRIC_LABELS[\`\${cluster.cluster}_jobs\`] || 'Jobs', formatStatsValue(\`\${cluster.cluster}_jobs\`)],
                    [JOB_METRIC_LABELS[\`\${cluster.cluster}_running_jobs\`] || 'Running Jobs', formatStatsValue(\`\${cluster.cluster}_running_jobs\`)],
                    [JOB_METRIC_LABELS[\`\${cluster.cluster}_pending_jobs\`] || 'Pending Jobs', formatStatsValue(\`\${cluster.cluster}_pending_jobs\`)],
                    [JOB_METRIC_LABELS[\`\${cluster.cluster}_other_jobs\`] || 'Other Jobs', formatStatsValue(\`\${cluster.cluster}_other_jobs\`)],
                    [JOB_METRIC_LABELS[\`\${cluster.cluster}_cpu_count\`] || 'CPU Count', formatStatsValue(\`\${cluster.cluster}_cpu_count\`)],
                    [JOB_METRIC_LABELS[\`\${cluster.cluster}_gpu_count\`] || 'GPU Count', formatStatsValue(\`\${cluster.cluster}_gpu_count\`)],
                    [JOB_METRIC_LABELS[\`\${cluster.cluster}_remaining_hours\`] || 'Remaining Hours', formatStatsValue(\`\${cluster.cluster}_remaining_hours\`)],
                    [JOB_METRIC_LABELS[\`\${cluster.cluster}_cpu_hours_remaining\`] || 'CPU Hours Remaining', formatStatsValue(\`\${cluster.cluster}_cpu_hours_remaining\`)],
                    [JOB_METRIC_LABELS[\`\${cluster.cluster}_gpu_hours_remaining\`] || 'GPU Hours Remaining', formatStatsValue(\`\${cluster.cluster}_gpu_hours_remaining\`)],
                ],
            }));

            const cards = [
                {
                    title: 'Overall Jobs',
                    rows: [
                        [JOB_METRIC_LABELS.total_jobs || 'Total Jobs', formatStatsValue('total_jobs')],
                        [JOB_METRIC_LABELS.running_jobs || 'Running Jobs', formatStatsValue('running_jobs')],
                        [JOB_METRIC_LABELS.pending_jobs || 'Pending Jobs', formatStatsValue('pending_jobs')],
                        [JOB_METRIC_LABELS.other_jobs || 'Other Jobs', formatStatsValue('other_jobs')],
                        [JOB_METRIC_LABELS.total_cpu_count || 'Total CPU Count', formatStatsValue('total_cpu_count')],
                        [JOB_METRIC_LABELS.total_gpu_count || 'Total GPU Count', formatStatsValue('total_gpu_count')],
                    ],
                },
                {
                    title: 'Overall Time',
                    rows: [
                        [JOB_METRIC_LABELS.total_elapsed_hours || 'Total Elapsed Hours', formatStatsValue('total_elapsed_hours')],
                        [JOB_METRIC_LABELS.total_remaining_hours || 'Total Remaining Hours', formatStatsValue('total_remaining_hours')],
                        [JOB_METRIC_LABELS.total_time_limit_hours || 'Total Time Limit Hours', formatStatsValue('total_time_limit_hours')],
                    ],
                },
                {
                    title: 'Overall CPU Hours',
                    rows: [
                        [JOB_METRIC_LABELS.total_cpu_hours_elapsed || 'CPU Hours Elapsed', formatStatsValue('total_cpu_hours_elapsed')],
                        [JOB_METRIC_LABELS.total_cpu_hours_remaining || 'CPU Hours Remaining', formatStatsValue('total_cpu_hours_remaining')],
                        [JOB_METRIC_LABELS.total_cpu_hours_limit || 'CPU Hours Limit', formatStatsValue('total_cpu_hours_limit')],
                    ],
                },
                {
                    title: 'Overall GPU Hours',
                    rows: [
                        [JOB_METRIC_LABELS.total_gpu_hours_elapsed || 'GPU Hours Elapsed', formatStatsValue('total_gpu_hours_elapsed')],
                        [JOB_METRIC_LABELS.total_gpu_hours_remaining || 'GPU Hours Remaining', formatStatsValue('total_gpu_hours_remaining')],
                        [JOB_METRIC_LABELS.total_gpu_hours_limit || 'GPU Hours Limit', formatStatsValue('total_gpu_hours_limit')],
                    ],
                },
                ...clusterCards,
            ];

            if (metricKey !== 'none') {
                cards.push({
                    title: 'Overlay Metric',
                    rows: [
                        ['Metric', OVERLAY_METRIC_LABELS[metricKey] || metricKey],
                        ['Current', formatJobMetricValue(metricKey, overlayMetricValueForRow(latestFairshareRow, metricKey))],
                        ['Selection \\u0394', selectionMetricDelta === undefined ? '--' : formatJobMetricDelta(metricKey, selectionMetricDelta)],
                        ['Selection span', selection ? formatDuration(currentRows[selection.startIndex].date, currentRows[selection.endIndex].date) : '--'],
                    ],
                });
            }

            jobStats.innerHTML = \`
                <div class="selection-header">Job Statistics</div>
                <div class="selection-subtle">Latest aligned job snapshot: \${formatTime(latestJobRow.date)}</div>
                <div class="stats-grid">\${cards.map((card) => \`
                    <div class="stats-card">
                        <div class="stats-card-title">\${card.title}</div>
                        \${card.rows.map(([label, value]) => \`<div class="stats-row"><span>\${label}</span><strong>\${value}</strong></div>\`).join('')}
                    </div>
                \`).join('')}</div>
            \`;
        }

        function analysisRowsWithinSelection(rows) {
            const selection = displayedSelection();
            if (!selection) {
                return rows;
            }
            return rows.slice(selection.startIndex, selection.endIndex + 1);
        }

        function integrateMetric(rows, metricKey) {
            if (rows.length < 2) {
                return 0;
            }
            let total = 0;
            for (let index = 1; index < rows.length; index += 1) {
                const previous = rows[index - 1];
                const current = rows[index];
                const previousValue = jobMetricValueForRow(previous, metricKey);
                const currentValue = jobMetricValueForRow(current, metricKey);
                if (typeof previousValue !== 'number' || typeof currentValue !== 'number') {
                    continue;
                }
                const durationHours = Math.max(0, current.date.getTime() - previous.date.getTime()) / 3600000;
                total += ((previousValue + currentValue) / 2) * durationHours;
            }
            return total;
        }

        function averageMetric(rows, metricKey) {
            const values = rows
                .map((row) => jobMetricValueForRow(row, metricKey))
                .filter((value) => typeof value === 'number');
            if (values.length === 0) {
                return undefined;
            }
            return values.reduce((sum, value) => sum + value, 0) / values.length;
        }

        function fairshareDelta(rows, seriesKey) {
            if (rows.length < 2) {
                return undefined;
            }
            const startValue = rows[0].values[seriesKey];
            const endValue = rows[rows.length - 1].values[seriesKey];
            if (typeof startValue !== 'number' || typeof endValue !== 'number') {
                return undefined;
            }
            return endValue - startValue;
        }

        function idleRecoveryRate(rows, clusterKey, seriesKey) {
            if (rows.length < 2) {
                return undefined;
            }
            const jobMetricKey = clusterMetricKey(clusterKey, 'jobs');
            let totalPositiveDelta = 0;
            let idleHours = 0;
            for (let index = 1; index < rows.length; index += 1) {
                const previous = rows[index - 1];
                const current = rows[index];
                const previousJobs = jobMetricValueForRow(previous, jobMetricKey);
                const currentJobs = jobMetricValueForRow(current, jobMetricKey);
                const previousFairshare = previous.values[seriesKey];
                const currentFairshare = current.values[seriesKey];
                if (
                    typeof previousJobs !== 'number'
                    || typeof currentJobs !== 'number'
                    || typeof previousFairshare !== 'number'
                    || typeof currentFairshare !== 'number'
                ) {
                    continue;
                }
                if (previousJobs === 0 && currentJobs === 0) {
                    const delta = currentFairshare - previousFairshare;
                    if (delta > 0) {
                        totalPositiveDelta += delta;
                    }
                    idleHours += Math.max(0, current.date.getTime() - previous.date.getTime()) / 3600000;
                }
            }
            if (idleHours <= 0) {
                return undefined;
            }
            return totalPositiveDelta / idleHours;
        }

        function analysisClusters() {
            const cluster = selectedCluster();
            if (cluster === 'all') {
                return CLUSTERS.map((item) => item.cluster);
            }
            return [cluster];
        }

        function renderEfficiencyMetrics(rows) {
            const analysisRows = analysisRowsWithinSelection(rows);
            if (analysisRows.length < 2) {
                efficiencyView.innerHTML = '<div class="section-title">Efficiency Metrics</div><div class="section-subtle">Select a range with at least two samples to compute efficiency metrics.</div>';
                return;
            }

            const range = rowForSelectionRange(rows);
            const events = range ? filteredEventsForRange(range.startRow.date, range.endRow.date) : [];
            const cards = analysisClusters().map((clusterKey) => {
                const clusterLabel = eventsClusterLabel(clusterKey);
                const cpuSeriesKey = \`\${clusterKey}_cpu\`;
                const gpuSeriesKey = \`\${clusterKey}_gpu\`;
                const cpuDelta = fairshareDelta(analysisRows, cpuSeriesKey);
                const gpuDelta = fairshareDelta(analysisRows, gpuSeriesKey);
                const cpuHoursUsed = integrateMetric(analysisRows, clusterMetricKey(clusterKey, 'cpu_count'));
                const gpuHoursUsed = integrateMetric(analysisRows, clusterMetricKey(clusterKey, 'gpu_count'));
                const distinctJobs = uniqueJobsInEvents(events, clusterKey);
                const averageJobs = averageMetric(analysisRows, clusterMetricKey(clusterKey, 'jobs'));
                const gpuIdleRecovery = idleRecoveryRate(analysisRows, clusterKey, gpuSeriesKey);
                const cpuIdleRecovery = idleRecoveryRate(analysisRows, clusterKey, cpuSeriesKey);
                const latestRow = analysisRows[analysisRows.length - 1];
                const schedulableNodes = overlayMetricValueForRow(latestRow, clusterMetricKey(clusterKey, 'schedulable_gpu_nodes'));
                const downNodes = overlayMetricValueForRow(latestRow, clusterMetricKey(clusterKey, 'down_gpu_nodes'));
                const drainNodes = overlayMetricValueForRow(latestRow, clusterMetricKey(clusterKey, 'drain_gpu_nodes'));

                return \`
                    <div class="eff-card">
                        <div class="eff-title">\${clusterLabel}</div>
                        <div class="eff-row"><span>CPU fairshare \\u0394</span><strong>\${cpuDelta === undefined ? '--' : formatDelta(cpuDelta)}</strong></div>
                        <div class="eff-row"><span>GPU fairshare \\u0394</span><strong>\${gpuDelta === undefined ? '--' : formatDelta(gpuDelta)}</strong></div>
                        <div class="eff-row"><span>CPU fairshare \\u0394 / CPU-hour</span><strong>\${cpuDelta === undefined || cpuHoursUsed <= 0 ? '--' : formatDelta(cpuDelta / cpuHoursUsed)}</strong></div>
                        <div class="eff-row"><span>GPU fairshare \\u0394 / GPU-hour</span><strong>\${gpuDelta === undefined || gpuHoursUsed <= 0 ? '--' : formatDelta(gpuDelta / gpuHoursUsed)}</strong></div>
                        <div class="eff-row"><span>GPU fairshare \\u0394 / distinct job</span><strong>\${gpuDelta === undefined || distinctJobs <= 0 ? '--' : formatDelta(gpuDelta / distinctJobs)}</strong></div>
                        <div class="eff-row"><span>Average active jobs</span><strong>\${averageJobs === undefined ? '--' : averageJobs.toFixed(2)}</strong></div>
                        <div class="eff-row"><span>Schedulable GPU nodes</span><strong>\${formatJobMetricValue(clusterMetricKey(clusterKey, 'schedulable_gpu_nodes'), schedulableNodes)}</strong></div>
                        <div class="eff-row"><span>Down GPU nodes</span><strong>\${formatJobMetricValue(clusterMetricKey(clusterKey, 'down_gpu_nodes'), downNodes)}</strong></div>
                        <div class="eff-row"><span>Drain GPU nodes</span><strong>\${formatJobMetricValue(clusterMetricKey(clusterKey, 'drain_gpu_nodes'), drainNodes)}</strong></div>
                        <div class="eff-row"><span>Idle recovery rate (CPU/hr)</span><strong>\${cpuIdleRecovery === undefined ? '--' : formatDelta(cpuIdleRecovery)}</strong></div>
                        <div class="eff-row"><span>Idle recovery rate (GPU/hr)</span><strong>\${gpuIdleRecovery === undefined ? '--' : formatDelta(gpuIdleRecovery)}</strong></div>
                    </div>
                \`;
            }).join('');

            efficiencyView.innerHTML = \`
                <div class="section-title">Efficiency Metrics</div>
                <div class="section-subtle">Calculated over the current visible range\${displayedSelection() ? ' and drag selection' : ''}. GPU-hour metrics integrate the observed GPU counts over time.</div>
                <div class="efficiency-grid">\${cards || '<div class="empty">No efficiency metrics are available for this range.</div>'}</div>
            \`;
        }

        function pearsonCorrelation(xs, ys) {
            if (xs.length !== ys.length || xs.length < 3) {
                return undefined;
            }
            const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
            const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
            let numerator = 0;
            let denominatorX = 0;
            let denominatorY = 0;
            for (let index = 0; index < xs.length; index += 1) {
                const dx = xs[index] - meanX;
                const dy = ys[index] - meanY;
                numerator += dx * dy;
                denominatorX += dx * dx;
                denominatorY += dy * dy;
            }
            if (denominatorX <= 0 || denominatorY <= 0) {
                return undefined;
            }
            return numerator / Math.sqrt(denominatorX * denominatorY);
        }

        function computeBestLag(rows, fairshareSeriesKey, jobMetricKey) {
            const stepMinutes = Math.max(1, Math.round(selectedAggregationBucketMs() > 0
                ? selectedAggregationBucketMs() / 60000
                : ((rows.length > 1 ? rows[1].date.getTime() - rows[0].date.getTime() : 60000) / 60000)));
            const lagMinutes = [0, stepMinutes, stepMinutes * 2, stepMinutes * 4, stepMinutes * 8, stepMinutes * 12];
            let best = undefined;

            for (const lagMinute of Array.from(new Set(lagMinutes))) {
                const offset = Math.max(0, Math.round(lagMinute / stepMinutes));
                const xs = [];
                const ys = [];
                for (let index = 0; index + offset < rows.length; index += 1) {
                    const metricValue = overlayMetricValueForRow(rows[index], jobMetricKey);
                    const fairshareValue = rows[index + offset].values[fairshareSeriesKey];
                    if (typeof metricValue !== 'number' || typeof fairshareValue !== 'number') {
                        continue;
                    }
                    xs.push(metricValue);
                    ys.push(fairshareValue);
                }
                const correlation = pearsonCorrelation(xs, ys);
                if (correlation === undefined) {
                    continue;
                }
                if (!best || Math.abs(correlation) > Math.abs(best.correlation)) {
                    best = {
                        lagMinutes: lagMinute,
                        correlation,
                        samples: xs.length,
                    };
                }
            }

            return best;
        }

        function renderLagCorrelation(rows) {
            const analysisRows = analysisRowsWithinSelection(rows);
            if (analysisRows.length < 4) {
                lagCorrelationView.innerHTML = '<div class="section-title">Lag / Correlation</div><div class="section-subtle">At least four samples are needed for lag analysis.</div>';
                return;
            }

            const cards = analysisClusters().map((clusterKey) => {
                const preferredSeries = toggleGpu.checked ? \`\${clusterKey}_gpu\` : \`\${clusterKey}_cpu\`;
                const fallbackSeries = toggleGpu.checked ? \`\${clusterKey}_cpu\` : \`\${clusterKey}_gpu\`;
                const fairshareSeriesKey = analysisRows.some((row) => typeof row.values[preferredSeries] === 'number')
                    ? preferredSeries
                    : fallbackSeries;
                const jobsMetricKey = clusterMetricKey(clusterKey, 'jobs');
                const gpuHoursMetricKey = clusterMetricKey(clusterKey, 'gpu_hours_remaining');
                const schedulableNodesMetricKey = clusterMetricKey(clusterKey, 'schedulable_gpu_nodes');
                const downNodesMetricKey = clusterMetricKey(clusterKey, 'down_gpu_nodes');
                const jobsLag = computeBestLag(analysisRows, fairshareSeriesKey, jobsMetricKey);
                const gpuLag = computeBestLag(analysisRows, fairshareSeriesKey, gpuHoursMetricKey);
                const schedulableLag = computeBestLag(analysisRows, fairshareSeriesKey, schedulableNodesMetricKey);
                const downLag = computeBestLag(analysisRows, fairshareSeriesKey, downNodesMetricKey);

                return \`
                    <div class="corr-card">
                        <div class="corr-title">\${eventsClusterLabel(clusterKey)} using \${SERIES_LABELS[fairshareSeriesKey] || fairshareSeriesKey}</div>
                        <div class="corr-row"><span>Best lag vs job count</span><strong>\${jobsLag ? \`\${jobsLag.lagMinutes}m (r=\${jobsLag.correlation.toFixed(3)})\` : '--'}</strong></div>
                        <div class="corr-row"><span>Samples used</span><strong>\${jobsLag ? jobsLag.samples : '--'}</strong></div>
                        <div class="corr-row"><span>Best lag vs GPU-hours remaining</span><strong>\${gpuLag ? \`\${gpuLag.lagMinutes}m (r=\${gpuLag.correlation.toFixed(3)})\` : '--'}</strong></div>
                        <div class="corr-row"><span>Samples used</span><strong>\${gpuLag ? gpuLag.samples : '--'}</strong></div>
                        <div class="corr-row"><span>Best lag vs schedulable GPU nodes</span><strong>\${schedulableLag ? \`\${schedulableLag.lagMinutes}m (r=\${schedulableLag.correlation.toFixed(3)})\` : '--'}</strong></div>
                        <div class="corr-row"><span>Samples used</span><strong>\${schedulableLag ? schedulableLag.samples : '--'}</strong></div>
                        <div class="corr-row"><span>Best lag vs down GPU nodes</span><strong>\${downLag ? \`\${downLag.lagMinutes}m (r=\${downLag.correlation.toFixed(3)})\` : '--'}</strong></div>
                        <div class="corr-row"><span>Samples used</span><strong>\${downLag ? downLag.samples : '--'}</strong></div>
                    </div>
                \`;
            }).join('');

            lagCorrelationView.innerHTML = \`
                <div class="section-title">Lag / Correlation</div>
                <div class="section-subtle">Positive lag means the selected job metric leads fairshare by that many minutes.</div>
                <div class="corr-grid">\${cards || '<div class="empty">No lag/correlation results are available for this range.</div>'}</div>
            \`;
        }

        function renderEventTable(rows) {
            const range = rowForSelectionRange(rows);
            if (!range) {
                eventTableView.innerHTML = '<div class="section-title">Job Event Log</div><div class="section-subtle">No rows are available for the current range.</div>';
                return;
            }

            const events = filteredEventsForRange(range.startRow.date, range.endRow.date)
                .sort((left, right) => right.date.getTime() - left.date.getTime());
            const visibleEvents = events.slice(0, 80);

            const legendHtml = Object.entries(EVENT_LABELS).map(([type, label]) => (
                \`<span class="event-pill">\${eventShortSymbol(type)} \${label}</span>\`
            )).join('');

            const rowsHtml = visibleEvents.map((event) => {
                const jobLabel = event.jobId ? \`\${event.name || '--'} (#\${event.jobId})\` : '--';
                const stateLabel = event.type === 'queue_change'
                    ? \`\${event.beforeJobs ?? '--'} \\u2192 \${event.afterJobs ?? '--'}\`
                    : [event.fromState || '', event.toState || ''].filter(Boolean).join(' \\u2192 ') || '--';
                return \`
                    <tr>
                        <td>\${formatTime(event.date)}</td>
                        <td>\${eventsClusterLabel(event.remote)}</td>
                        <td><span class="event-pill" style="\${eventPillStyle(event)}">\${eventShortSymbol(event.type)} \${formatEventType(event.type)}</span></td>
                        <td>\${jobLabel}</td>
                        <td>\${stateLabel}</td>
                        <td>\${event.numCpus ?? '--'}</td>
                        <td>\${event.numGpus ?? '--'}</td>
                        <td>\${formatHoursValue(event.elapsedHours)}</td>
                        <td>\${formatHoursValue(event.remainingHours)}</td>
                        <td>\${event.note || '--'}</td>
                    </tr>
                \`;
            }).join('');

            eventTableView.innerHTML = \`
                <div class="section-title">Job Event Log</div>
                <div class="section-subtle">Showing \${visibleEvents.length} of \${events.length} events in the current \${displayedSelection() ? 'selection' : 'visible range'}.</div>
                <div class="event-legend">\${legendHtml}</div>
                <div class="event-table-wrap">
                    <table class="event-table">
                        <thead>
                            <tr>
                                <th>Time</th>
                                <th>HPC</th>
                                <th>Event</th>
                                <th>Job</th>
                                <th>State / Jobs</th>
                                <th>CPU</th>
                                <th>GPU</th>
                                <th>Elapsed</th>
                                <th>Remaining</th>
                                <th>Notes</th>
                            </tr>
                        </thead>
                        <tbody>\${rowsHtml || '<tr><td colspan="10" class="empty">No job events were found for this range.</td></tr>'}</tbody>
                    </table>
                </div>
            \`;
        }

        function scheduleRender() {
            if (pendingRenderFrame) {
                return;
            }
            pendingRenderFrame = requestAnimationFrame(() => {
                pendingRenderFrame = null;
                renderImmediate();
            });
        }

        function scheduleDeferredSections(rows) {
            if (pendingDeferredTimer) {
                clearTimeout(pendingDeferredTimer);
            }
            pendingDeferredTimer = setTimeout(() => {
                pendingDeferredTimer = null;
                renderEfficiencyMetrics(rows);
                renderLagCorrelation(rows);
                renderEventTable(rows);
            }, 0);
        }

        function renderImmediate() {
            const rows = currentRangeRows();
            currentRows = rows;
            currentJobRows = currentRangeJobRows();
            currentNodeRows = currentRangeNodeRows();
            const plotWidth = CHART.width - CHART.padding.left - CHART.padding.right;
            const plotHeight = CHART.height - CHART.padding.top - CHART.padding.bottom;
            currentPlotWidth = plotWidth;
            const activeSeriesKeys = visibleSeriesKeys();
            const jobMetricKey = selectedJobMetric();
            updateLegend(rows, activeSeriesKeys);

            if (activeSeriesKeys.length === 0) {
                svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" class="axis-label">Enable CPU or GPU to draw the graph.</text>';
                metrics.innerHTML = '<span>Series shown: <strong>0</strong></span>';
                tooltip.classList.remove('visible');
                renderSelectionSummary();
                renderJobStats(rows);
                scheduleDeferredSections(rows);
                return;
            }

            let valMin = Infinity;
            let valMax = -Infinity;
            for (const row of rows) {
                for (const sk of activeSeriesKeys) {
                    const v = row.values[sk];
                    if (typeof v === 'number') {
                        if (v < valMin) { valMin = v; }
                        if (v > valMax) { valMax = v; }
                    }
                }
            }

            if (rows.length === 0 || valMin > valMax) {
                svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" class="axis-label">No fairshare samples in this date range.</text>';
                metrics.innerHTML = '';
                tooltip.classList.remove('visible');
                renderSelectionSummary();
                renderJobStats(rows);
                scheduleDeferredSections(rows);
                return;
            }

            const rawMin = valMin;
            const rawMax = valMax;
            const spread = Math.max(rawMax - rawMin, 0.02);
            const yPadding = spread * 0.12;
            const yMin = Math.max(0, rawMin - yPadding);
            const yMax = rawMax + yPadding;
            const effectiveSpread = Math.max(yMax - yMin, 0.02);

            const xForIndex = (index) => {
                if (rows.length <= 1) {
                    return CHART.padding.left + plotWidth / 2;
                }
                return CHART.padding.left + (index / (rows.length - 1)) * plotWidth;
            };
            const timeSpanMs = Math.max(1, rows[rows.length - 1].date.getTime() - rows[0].date.getTime());
            const xForDate = (date) => {
                if (rows.length <= 1) {
                    return CHART.padding.left + plotWidth / 2;
                }
                const normalized = (date.getTime() - rows[0].date.getTime()) / timeSpanMs;
                const clamped = Math.max(0, Math.min(1, normalized));
                return CHART.padding.left + clamped * plotWidth;
            };
            currentXForIndex = xForIndex;

            const yForValue = (value) => {
                const normalized = (value - yMin) / effectiveSpread;
                return CHART.padding.top + plotHeight - normalized * plotHeight;
            };

            const gridFractions = [0, 0.25, 0.5, 0.75, 1];
            const grid = gridFractions.map((fraction) => {
                const value = yMin + effectiveSpread * fraction;
                return { value, y: yForValue(value) };
            });

            const overlayValues = [];
            if (jobMetricKey !== 'none') {
                for (const row of rows) {
                    const v = overlayMetricValueForRow(row, jobMetricKey);
                    if (typeof v === 'number') {
                        overlayValues.push(v);
                    }
                }
            }
            const overlayBounds = minMaxValues(overlayValues);
            const overlayMin = overlayBounds.min;
            const overlayMax = overlayBounds.max;
            const overlaySpread = Math.max(overlayMax - overlayMin, 1);
            const overlayPadding = overlaySpread * 0.12;
            const overlayYMin = overlayValues.length > 0 ? Math.max(0, overlayMin - overlayPadding) : 0;
            const overlayYMax = overlayValues.length > 0 ? overlayMax + overlayPadding : 1;
            const overlayEffectiveSpread = Math.max(overlayYMax - overlayYMin, 1);
            const overlayYForValue = (value) => {
                const normalized = (value - overlayYMin) / overlayEffectiveSpread;
                return CHART.padding.top + plotHeight - normalized * plotHeight;
            };

            const series = activeSeriesKeys.map((seriesKey) => {
                const rawPoints = [];
                for (let i = 0; i < rows.length; i++) {
                    const value = rows[i].values[seriesKey];
                    if (typeof value === 'number') {
                        rawPoints.push({ rowIndex: i, timestamp: rows[i].timestamp, date: rows[i].date, value });
                    }
                }
                return {
                    seriesKey,
                    label: SERIES_LABELS[seriesKey],
                    color: SERIES_COLORS[seriesKey],
                    dasharray: SERIES_DASHARRAY[seriesKey],
                    points: rawPoints,
                };
            });
            currentSeries = series;

            const rawOverlaySeries = [];
            if (jobMetricKey !== 'none') {
                for (let i = 0; i < rows.length; i++) {
                    const v = overlayMetricValueForRow(rows[i], jobMetricKey);
                    if (typeof v === 'number') {
                        rawOverlaySeries.push({ rowIndex: i, date: rows[i].date, value: v });
                    }
                }
            }

            const firstTimestamp = formatTime(rows[0].date);
            const lastTimestamp = formatTime(rows[rows.length - 1].date);

            const xTicks = rows.length <= 1 ? [0] : [0, Math.floor((rows.length - 1) / 2), rows.length - 1];
            const xTickLabels = Array.from(new Set(xTicks)).map((index) => ({
                x: xForIndex(index),
                label: formatTime(rows[index].date),
                anchor: index === 0 ? 'start' : (index === rows.length - 1 ? 'end' : 'middle'),
            }));
            const verticalGridFractions = [0, 0.25, 0.5, 0.75, 1];
            const verticalGridLines = verticalGridFractions.map((fraction) => (
                CHART.padding.left + plotWidth * fraction
            ));

            const polylines = series.map((entry) => {
                if (entry.points.length === 0) {
                    return '';
                }
                const decimated = decimatePoints(entry.points, MAX_POLYLINE_POINTS);
                const coords = new Array(decimated.length);
                for (let i = 0; i < decimated.length; i++) {
                    const p = decimated[i];
                    coords[i] = xForIndex(p.rowIndex) + ',' + yForValue(p.value);
                }
                const dashAttribute = entry.dasharray ? ' stroke-dasharray="' + entry.dasharray + '"' : '';
                return '<polyline fill="none" stroke="' + entry.color + '" stroke-width="3" points="' + coords.join(' ') + '" stroke-linejoin="round" stroke-linecap="round"' + dashAttribute + '></polyline>';
            }).join('');

            let overlayPolyline = '';
            if (rawOverlaySeries.length > 0) {
                const decimated = decimatePoints(rawOverlaySeries, MAX_POLYLINE_POINTS);
                const coords = new Array(decimated.length);
                for (let i = 0; i < decimated.length; i++) {
                    const p = decimated[i];
                    coords[i] = xForIndex(p.rowIndex) + ',' + overlayYForValue(p.value);
                }
                overlayPolyline = '<polyline fill="none" stroke="#bfc7d5" stroke-width="2.5" points="' + coords.join(' ') + '" stroke-linejoin="round" stroke-linecap="round" opacity="0.95"></polyline>';
            }

            const overlayGrid = overlayValues.length > 0
                ? gridFractions.map((fraction) => {
                    const value = overlayYMin + overlayEffectiveSpread * fraction;
                    const y = overlayYForValue(value);
                    return \`<text class="axis-label" x="\${CHART.width - CHART.padding.right + 10}" y="\${y + 4}" text-anchor="start">\${formatJobMetricValue(jobMetricKey, value)}</text>\`;
                }).join('')
                : '';
            const markerEvents = filteredEventsForRange(rows[0].date, rows[rows.length - 1].date);
            const positionedEvents = markerEvents.map((event) => ({
                ...event,
                rowIndex: binarySearchNearestIndex(rows, event.date.getTime()),
            }));
            const runningIntervals = runningIntervalsForRange(rows[0].date, rows[rows.length - 1].date);
            const laidOutIntervals = layoutIntervalsIntoLanes(runningIntervals);
            const laneCount = laidOutIntervals.reduce((maxLane, span) => Math.max(maxLane, span.laneIndex + 1), 0);
            const laneGap = 2;
            const laneHeight = laneCount > 0
                ? Math.max(2, Math.min(14, Math.floor(plotHeight / laneCount)))
                : 0;
            const runningIntervalSvg = laidOutIntervals.map((span) => {
                const color = SERIES_COLORS[span.remote + '_gpu'] || '#bfc7d5';
                const left = xForDate(span.start);
                const right = xForDate(span.end);
                const width = Math.max(1, right - left);
                const y = CHART.padding.top + span.laneIndex * laneHeight;
                const height = Math.max(1, laneHeight - laneGap);
                return '<rect x="' + left
                    + '" y="' + y
                    + '" width="' + width
                    + '" height="' + height
                    + '" fill="' + color
                    + '" opacity="0.25"></rect>';
            }).join('');
            svg.innerHTML = \`
                \${verticalGridLines.map((x) => \`<line class="grid-line" x1="\${x}" y1="\${CHART.padding.top}" x2="\${x}" y2="\${CHART.padding.top + plotHeight}"></line>\`).join('')}
                \${grid.map((line) => \`
                    <line class="grid-line" x1="\${CHART.padding.left}" y1="\${line.y}" x2="\${CHART.width - CHART.padding.right}" y2="\${line.y}"></line>
                    <text class="axis-label" x="\${CHART.padding.left - 10}" y="\${line.y + 4}" text-anchor="end">\${line.value.toFixed(3)}</text>
                \`).join('')}
                <line class="grid-line" x1="\${CHART.padding.left}" y1="\${CHART.padding.top}" x2="\${CHART.padding.left}" y2="\${CHART.padding.top + plotHeight}"></line>
                <line class="grid-line" x1="\${CHART.padding.left}" y1="\${CHART.padding.top + plotHeight}" x2="\${CHART.width - CHART.padding.right}" y2="\${CHART.padding.top + plotHeight}"></line>
                <line class="grid-line" x1="\${CHART.width - CHART.padding.right}" y1="\${CHART.padding.top}" x2="\${CHART.width - CHART.padding.right}" y2="\${CHART.padding.top + plotHeight}"></line>
                \${runningIntervalSvg}
                \${polylines}
                \${overlayPolyline}
                \${overlayGrid}
                <rect id="selectionRect" x="0" y="0" width="0" height="0" fill="var(--vscode-textLink-activeForeground)" opacity="0"></rect>
                <line id="hoverLine" x1="0" y1="\${CHART.padding.top}" x2="0" y2="\${CHART.padding.top + plotHeight}" stroke="var(--vscode-editorCursor-foreground)" stroke-width="1.2" stroke-dasharray="4 4" opacity="0"></line>
                <g id="hoverPoints"></g>
                <rect id="hoverOverlay" x="\${CHART.padding.left}" y="\${CHART.padding.top}" width="\${plotWidth}" height="\${plotHeight}" fill="transparent"></rect>
                \${xTickLabels.map((tick) => \`<text class="axis-label" x="\${tick.x}" y="\${CHART.height - 24}" text-anchor="\${tick.anchor}">\${tick.label}</text>\`).join('')}
                <text class="axis-label" x="\${CHART.padding.left}" y="\${CHART.height - 8}" text-anchor="start">Start: \${firstTimestamp}</text>
                <text class="axis-label" x="\${CHART.width - CHART.padding.right}" y="\${CHART.height - 8}" text-anchor="end">End: \${lastTimestamp}</text>
            \`;

            metrics.innerHTML = [
                \`<span>Samples: <strong>\${rows.length}</strong></span>\`,
                \`<span>Series shown: <strong>\${activeSeriesKeys.length}</strong></span>\`,
                \`<span>Aggregation: <strong>\${aggregationSelect.value.toUpperCase()}</strong></span>\`,
                \`<span>Scope: <strong>\${selectedCluster() === 'all' ? 'All HPCs' : eventsClusterLabel(selectedCluster())}</strong></span>\`,
                \`<span>Events: <strong>\${markerEvents.length}</strong></span>\`,
                \`<span>Visible fairshare range: <strong>\${yMin.toFixed(3)} - \${yMax.toFixed(3)}</strong></span>\`,
                \`<span>Overlay: <strong>\${jobMetricKey === 'none' ? 'off' : (OVERLAY_METRIC_LABELS[jobMetricKey] || jobMetricKey)}</strong></span>\`,
                \`<span>Y-axis auto-zoom: <strong>on</strong></span>\`
            ].join('');

            const hoverOverlay = document.getElementById('hoverOverlay');
            const hoverLine = document.getElementById('hoverLine');
            const hoverPoints = document.getElementById('hoverPoints');

            function hideHover() {
                tooltip.classList.remove('visible');
                hoverLine.setAttribute('opacity', '0');
                hoverPoints.innerHTML = '';
            }

            function renderHoverForRowIndex(rowIndex, clientX, clientY) {
                currentHoveredIndex = rowIndex;
                const row = rows[rowIndex];
                const x = xForIndex(rowIndex);
                const selection = displayedSelection();
                const isSelectionEnd = selection && rowIndex === selection.endIndex;
                const selectionStartRow = selection ? rows[selection.startIndex] : null;

                hoverLine.setAttribute('x1', String(x));
                hoverLine.setAttribute('x2', String(x));
                hoverLine.setAttribute('opacity', '1');

                hoverPoints.innerHTML = series
                    .filter((entry) => typeof row.values[entry.seriesKey] === 'number')
                    .map((entry) => {
                        const value = Number(row.values[entry.seriesKey]);
                        return \`<circle cx="\${x}" cy="\${yForValue(value)}" r="5" fill="\${entry.color}" stroke="var(--vscode-editor-background)" stroke-width="2"></circle>\`;
                    })
                    .join('');

                const tooltipRows = series
                    .filter((entry) => typeof row.values[entry.seriesKey] === 'number')
                    .map((entry) => \`
                        <div class="tooltip-row">
                            <span class="tooltip-swatch" style="background:\${entry.color};"></span>
                            <span>\${entry.label}</span>
                            <span class="tooltip-value">\${Number(row.values[entry.seriesKey]).toFixed(3)}\${isSelectionEnd && selectionStartRow && typeof selectionStartRow.values[entry.seriesKey] === 'number' ? \` (\${formatDelta(Number(row.values[entry.seriesKey]) - Number(selectionStartRow.values[entry.seriesKey]))})\` : ''}</span>
                        </div>
                    \`)
                    .join('');
                const overlayValue = overlayMetricValueForRow(row, jobMetricKey);
                const overlayDelta = (isSelectionEnd && selectionStartRow && typeof overlayValue === 'number')
                    ? (() => {
                        const startValue = overlayMetricValueForRow(selectionStartRow, jobMetricKey);
                        return typeof startValue === 'number' ? overlayValue - startValue : undefined;
                    })()
                    : undefined;
                const overlayRow = (jobMetricKey !== 'none' && typeof overlayValue === 'number')
                    ? \`<div class="tooltip-row"><span class="tooltip-swatch" style="background:#bfc7d5;"></span><span>\${OVERLAY_METRIC_LABELS[jobMetricKey] || jobMetricKey}</span><span class="tooltip-value">\${formatJobMetricValue(jobMetricKey, overlayValue)}\${overlayDelta === undefined ? '' : \` (\${formatJobMetricDelta(jobMetricKey, overlayDelta)})\`}</span></div>\`
                    : '';
                const eventRows = positionedEvents
                    .filter((event) => event.rowIndex === rowIndex)
                    .slice(0, 6)
                    .map((event) => \`<div class="tooltip-row"><span class="tooltip-swatch" style="background:\${eventAccentColor(event)};"></span><span>\${eventShortSymbol(event.type)} \${formatEventType(event.type)} \\u2022 \${eventsClusterLabel(event.remote)}</span><span class="tooltip-value">\${event.jobId ? \`#\${event.jobId}\` : (event.deltaJobs >= 0 ? \`+\${event.deltaJobs}\` : \`\${event.deltaJobs}\`)}</span></div>\`)
                    .join('');

                tooltip.innerHTML = \`
                    <div class="tooltip-title">\${formatTime(row.date)}</div>
                    \${tooltipRows || '<div class="tooltip-row">No values</div>'}
                    \${overlayRow}
                    \${eventRows}
                \`;
                tooltip.classList.add('visible');

                const tooltipRect = tooltip.getBoundingClientRect();
                const containerRect = svg.parentElement.getBoundingClientRect();
                const svgRect = svg.getBoundingClientRect();
                const defaultLeft = ((x / CHART.width) * svgRect.width) + (svgRect.left - containerRect.left) + 14;
                const defaultTop = ((CHART.padding.top / CHART.height) * svgRect.height) + (svgRect.top - containerRect.top) + 14;
                const left = Math.min(
                    containerRect.width - tooltipRect.width - 12,
                    Math.max(12, (typeof clientX === 'number' ? clientX - containerRect.left + 14 : defaultLeft))
                );
                const top = Math.min(
                    containerRect.height - tooltipRect.height - 12,
                    Math.max(12, (typeof clientY === 'number' ? clientY - containerRect.top + 14 : defaultTop))
                );
                tooltip.style.left = \`\${left}px\`;
                tooltip.style.top = \`\${top}px\`;
            }

            function showSelectionEndHover() {
                const selection = displayedSelection();
                if (!selection) {
                    hideHover();
                    return;
                }
                renderHoverForRowIndex(selection.endIndex);
            }

            function updateHover(clientX, clientY) {
                renderHoverForRowIndex(rowIndexFromClientX(clientX), clientX, clientY);
            }

            currentHoverUpdater = updateHover;
            currentSelectionHoverUpdater = showSelectionEndHover;
            currentHideHover = hideHover;

            hoverOverlay.addEventListener('mousemove', (event) => updateHover(event.clientX, event.clientY));
            hoverOverlay.addEventListener('mouseenter', (event) => updateHover(event.clientX, event.clientY));
            hoverOverlay.addEventListener('mouseleave', () => {
                if (!isDragging) {
                    if (displayedSelection()) {
                        showSelectionEndHover();
                    } else {
                        hideHover();
                    }
                }
            });
            hoverOverlay.addEventListener('mousedown', (event) => {
                if (event.button !== 0) {
                    return;
                }
                isDragging = true;
                dragAnchorIndex = rowIndexFromClientX(event.clientX);
                dragCurrentIndex = dragAnchorIndex;
                renderSelectionVisual();
                renderSelectionSummary();
                updateHover(event.clientX, event.clientY);
                event.preventDefault();
            });
            renderSelectionVisual();
            renderSelectionSummary();
            renderJobStats(rows);
            scheduleDeferredSections(rows);
            if (displayedSelection()) {
                showSelectionEndHover();
            } else if (currentHoveredIndex !== null && currentHoveredIndex < rows.length) {
                renderHoverForRowIndex(currentHoveredIndex);
            } else {
                hideHover();
            }
        }

        presetButtons.forEach((button) => {
            button.addEventListener('click', () => applyPreset(button.dataset.range || 'all'));
        });
        startInput.addEventListener('change', () => {
            setActivePreset('custom');
            clearSelection();
            scheduleRender();
        });
        endInput.addEventListener('change', () => {
            setActivePreset('custom');
            clearSelection();
            scheduleRender();
        });
        toggleCpu.addEventListener('change', () => {
            clearSelection();
            scheduleRender();
        });
        toggleGpu.addEventListener('change', () => {
            clearSelection();
            scheduleRender();
        });
        aggregationSelect.addEventListener('change', () => {
            clearSelection();
            scheduleRender();
        });
        clusterSelect.addEventListener('change', () => {
            clearSelection();
            scheduleRender();
        });
        jobMetricSelect.addEventListener('change', () => scheduleRender());
        clearSelectionButton.addEventListener('click', () => {
            clearSelection();
            scheduleRender();
        });
        document.addEventListener('mousemove', (event) => {
            if (!isDragging) {
                return;
            }
            dragCurrentIndex = rowIndexFromClientX(event.clientX);
            renderSelectionVisual();
            renderSelectionSummary();
            renderJobStats(currentRows);
            if (currentHoverUpdater) {
                currentHoverUpdater(event.clientX, event.clientY);
            }
        });
        document.addEventListener('mouseup', () => {
            if (!isDragging) {
                return;
            }
            isDragging = false;
            if (dragAnchorIndex === null || dragCurrentIndex === null) {
                clearSelection();
                return;
            }
            currentSelectionRange = {
                startIndex: Math.min(dragAnchorIndex, dragCurrentIndex),
                endIndex: Math.max(dragAnchorIndex, dragCurrentIndex),
            };
            dragAnchorIndex = null;
            dragCurrentIndex = null;
            scheduleRender();
        });

        // Rebuild row objects from the columnar payload. This is the same shape
        // the rest of the code expects ({ timestamp, date, values }); packing the
        // transport columnar just strips the repeated per-row key names.
        function reconstructRows(packed) {
            if (!packed || !packed.timestamps) {
                return [];
            }
            const timestamps = packed.timestamps;
            const keys = packed.keys || [];
            const columns = packed.columns || {};
            const rows = [];
            for (let i = 0; i < timestamps.length; i++) {
                const date = new Date(timestamps[i]);
                if (Number.isNaN(date.getTime())) {
                    continue;
                }
                const values = {};
                for (let k = 0; k < keys.length; k++) {
                    const column = columns[keys[k]];
                    const value = column ? column[i] : null;
                    if (value !== null && value !== undefined) {
                        values[keys[k]] = value;
                    }
                }
                rows.push({ timestamp: timestamps[i], date, values });
            }
            return rows;
        }

        function applyPayload(payload) {
            if (!payload) {
                return;
            }
            CHART.width = payload.chartWidth || CHART.width;
            CHART.height = payload.chartHeight || CHART.height;
            HISTORY_SERIES = payload.series || [];
            SERIES_LABELS = payload.seriesLabels || {};
            SERIES_COLORS = payload.seriesColors || {};
            SERIES_DASHARRAY = payload.seriesDasharray || {};
            CLUSTERS = payload.clusters || [];
            JOB_METRIC_KEYS = payload.jobMetricKeys || [];
            JOB_METRIC_LABELS = payload.jobMetricLabels || {};
            NODE_METRIC_KEYS = payload.nodeMetricKeys || [];
            NODE_METRIC_LABELS = payload.nodeMetricLabels || {};
            JOB_METRIC_KEY_SET = new Set(JOB_METRIC_KEYS);
            NODE_METRIC_KEY_SET = new Set(NODE_METRIC_KEYS);
            OVERLAY_METRIC_KEYS = [...JOB_METRIC_KEYS, ...NODE_METRIC_KEYS];
            OVERLAY_METRIC_LABELS = { ...JOB_METRIC_LABELS, ...NODE_METRIC_LABELS };

            allRows = reconstructRows(payload.history);
            allJobRows = reconstructRows(payload.jobHistory);
            allNodeRows = reconstructRows(payload.nodeHistory);
            allEvents = (payload.events || [])
                .map((event) => ({ ...event, date: new Date(event.timestamp) }))
                .filter((event) => !Number.isNaN(event.date.getTime()))
                .sort((left, right) => left.date.getTime() - right.date.getTime());
            allIntervals = (payload.intervals || [])
                .map((interval) => ({
                    remote: interval.remote,
                    jobId: interval.jobId,
                    name: interval.name,
                    start: new Date(interval.start),
                    end: new Date(interval.end),
                }))
                .filter((interval) => !Number.isNaN(interval.start.getTime()) && !Number.isNaN(interval.end.getTime()));

            const loadingOverlay = document.getElementById('loadingOverlay');
            if (loadingOverlay) {
                loadingOverlay.classList.add('hidden');
            }

            initializeJobMetricSelect();
            if (allRows.length > 0) {
                applyPreset('7d');
            } else {
                metrics.innerHTML = '<span>No fairshare history samples are available yet.</span>';
                updateLegend([], visibleSeriesKeys());
                renderSelectionSummary();
                renderJobStats([]);
                svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" class="axis-label">No fairshare history samples are available yet.</text>';
            }
        }

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message && message.type === 'dashboard') {
                applyPayload(message.payload);
            }
        });
        vscode.postMessage({ type: 'ready' });
`;
