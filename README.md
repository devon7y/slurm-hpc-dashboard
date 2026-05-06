# HPC Usage Dashboard

A VS Code extension that shows Slurm job status and fairshare history for one or more HPC clusters — directly in the status bar, hover tooltip, and a rich dashboard panel. It reads from a small set of local files that a companion Python monitor keeps up to date.

The current version is **0.4.0**.

## What It Does

### Status bar line

A single left-aligned status bar item that looks like this:

```text
Fir: 0.372 | Ror: 0.064 | Nibi: 0.774 | train_model (R) 1:23:45 | embed_docs (PD) 2:17
```

- cluster fairshare prefixes are pulled from `sshare`
- jobs are merged across clusters into one list
- running jobs count **down** and pending jobs count **up** locally between remote refreshes
- click the item to open the dashboard panel

### Hover tooltip

- compact per-job summary with totals by state
- latest fairshare sample timestamp
- eight-series fairshare trend (CPU + GPU × Fir/Ror/Nibi/Tril) with deltas and sparkline
- links to open the full raw status text, the dashboard, or the raw CSV

### Dashboard panel

<img width="1086" height="772" alt="hpc_dashboard" src="https://github.com/user-attachments/assets/68a738c6-9540-4e66-9606-8df27100d80d" />


- date-range presets (24H / 7D / 30D / 90D / 1Y / All) plus custom start/end
- per-cluster scoping and CPU/GPU toggles
- raw, 15m, 1h, and 6h aggregation buckets
- auto-zoomed y-axis so shallow fairshare changes are visible
- drag-to-select on the chart to measure net fairshare change over any window
- selectable overlay metric on a secondary right-side y-axis (any job or node metric)
- event markers and a job event log (submit / start / end / queue changes)
- efficiency metrics (fairshare delta per CPU-hour, per GPU-hour, per distinct job, idle recovery rate)
- lag/correlation cards relating fairshare to job load and GPU node availability

## Architecture

This repo has two parts:

1. **The VS Code extension** (`src/`) — reads local files and renders the UI. It does **not** connect to Slurm or run SSH directly.
2. **The Python monitor** (`scripts/`) — runs `ssh`, `squeue`, and `sshare` against your clusters and writes the files the extension reads.

### Files the extension reads

| Path | Written by monitor | Contents |
| --- | --- | --- |
| `~/.slurm_status_bar.txt` | every 1 s local tick | one-line status rendered in the status bar |
| `~/.slurm_fairshare_history.csv` | once per refresh | `timestamp,fir_cpu,fir_gpu,ror_cpu,ror_gpu,nibi_cpu,nibi_gpu,tril_cpu,tril_gpu` |
| `~/.slurm_job_history.csv` | once per refresh | aggregate job counts and CPU/GPU-hours, overall and per cluster |
| `~/.slurm_job_snapshot_history.csv` | once per refresh, one row per active job | used for event markers and the job event log |
| `~/.slurm_node_history.csv` | once per refresh | GPU node availability (schedulable / down / drain) per cluster |

If a file doesn't exist yet, the extension simply shows empty data until the monitor creates it.

### Source layout (after the 0.4.0 refactor)

```text
src/
├── extension.ts          # activation, commands, webview wiring
├── constants.ts          # file paths, cluster/series keys, colors
├── types.ts              # shared interfaces
├── csv.ts                # CSV line + history / job / snapshot parsers
├── dataReaders.ts        # async file readers with ENOENT fallbacks
├── statusBar.ts          # status bar item, file watcher, hover tooltip
└── dashboard/
    ├── html.ts           # webview HTML shell + bootstrap payload
    ├── styles.ts         # dashboard CSS
    └── script.ts         # dashboard webview JavaScript
```

## Requirements

- VS Code 1.60.0 or newer
- `ssh` client
- Python 3.8 or newer (for the monitor)
- access to one or more Slurm clusters where `squeue` works for your account

Recommended:

- SSH aliases in `~/.ssh/config`
- SSH ControlMaster enabled for faster polling
- key-based SSH login
- robot-node / automation-node aliases with constrained keys, if your site supports them

Optional:

- `sshpass`
- a passcode file for headless reconnects (the monitor will never prompt interactively)

## Quick Start

If you already have working SSH aliases such as `fir`, `ror`, `nibi`, and `tril`:

```bash
git clone https://github.com/devon7y/vscode-slurm-status-bar.git
cd vscode-slurm-status-bar
chmod +x scripts/slurm_monitor.sh

export SLURM_STATUS_BAR_REMOTE_USER=YOUR_CLUSTER_USERNAME
export SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT=YOUR_GPU_ACCOUNT

./scripts/slurm_monitor.sh fir ror nibi tril
```

Open another terminal and confirm the status file is updating:

```bash
cat ~/.slurm_status_bar.txt
```

You should see:

```text
Fir: 0.372 | Ror: 0.064 | Nibi: 0.774 | my_job (R) 1:23:45 | other_job (PD) 2:17
```

Then install the VS Code extension (see below), and optionally set the monitor to auto-start on login.

## 1. Install the VS Code Extension

### Option A — install a prebuilt `.vsix`

1. Download the latest `.vsix` from [Releases](https://github.com/devon7y/vscode-slurm-status-bar/releases).
2. In VS Code open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).
3. Run **Extensions: Install from VSIX…** and pick the downloaded file.
4. Reload the window when prompted.

### Option B — build your own `.vsix`

```bash
git clone https://github.com/devon7y/vscode-slurm-status-bar.git
cd vscode-slurm-status-bar
npm install
npm run compile
npx @vscode/vsce package
```

This produces e.g. `slurm-status-bar-0.4.0.vsix`, which you install the same way as Option A.

### Option C — run from source in an Extension Host

```bash
npm install
npm run watch        # keeps the TypeScript compiler running
```

Then open the repo in VS Code and press `F5` to launch an Extension Development Host with the extension loaded.

### Available commands

After install, the extension contributes these commands (Command Palette):

- `HPC Usage Dashboard: Show Full Status` — open the current status line in an editor
- `HPC Usage Dashboard: Open Dashboard` — open the webview dashboard (this is also the status bar click target)
- `HPC Usage Dashboard: Open Fairshare History CSV` — open `~/.slurm_fairshare_history.csv`

## 2. Configure SSH Access

The monitor works best if `ssh <alias> "squeue ..."` succeeds without an interactive prompt. In automation-node mode you can even use different aliases for `squeue` and `sshare`.

Minimum `~/.ssh/config`:

```sshconfig
Host fir
  HostName fir.alliancecan.ca
  User YOUR_CLUSTER_USERNAME
  ControlMaster auto
  ControlPersist 8h
  ControlPath ~/.ssh/cm-%C

Host ror
  HostName rorqual.alliancecan.ca
  User YOUR_CLUSTER_USERNAME
  ControlMaster auto
  ControlPersist 8h
  ControlPath ~/.ssh/cm-%C

Host nibi
  HostName nibi.alliancecan.ca
  User YOUR_CLUSTER_USERNAME
  ControlMaster auto
  ControlPersist 8h
  ControlPath ~/.ssh/cm-%C

Host tril
  HostName trillium-gpu.alliancecan.ca
  User YOUR_CLUSTER_USERNAME
  ControlMaster auto
  ControlPersist 8h
  ControlPath ~/.ssh/cm-%C
```

Notes:

- Alias names are arbitrary. Only `fir`, `ror`, `nibi`, `tril` get prettier labels in the dashboard; anything else still works but is rendered using the alias itself.
- If your local username and cluster username differ, set `SLURM_STATUS_BAR_REMOTE_USER`.

Sanity check before running the monitor:

```bash
ssh fir "squeue -u YOUR_CLUSTER_USERNAME --noheader"
ssh fir "sshare -u YOUR_CLUSTER_USERNAME -l -P"
```

Repeat for each alias.

### Automation-node / robot-node aliases (optional)

If your site provides constrained-key automation endpoints:

```sshconfig
Host robot-fir-slurm
  HostName robot.fir.alliancecan.ca
  User YOUR_CLUSTER_USERNAME
  IdentityFile ~/.ssh/id_ed25519_robot_slurm
  IdentitiesOnly yes
  BatchMode no
  RequestTTY no
  AddressFamily inet
  ControlMaster auto
  ControlPersist 12h
  ControlPath ~/.ssh/cm-robot-slurm-%C

Host robot-fir-fairshare
  HostName robot.fir.alliancecan.ca
  User YOUR_CLUSTER_USERNAME
  IdentityFile ~/.ssh/id_ed25519_robot_fairshare
  IdentitiesOnly yes
  BatchMode no
  RequestTTY no
  AddressFamily inet
  ControlMaster auto
  ControlPersist 12h
  ControlPath ~/.ssh/cm-robot-fairshare-%C
```

On the current Alliance robot-node setup, `BatchMode no` is required. The handshake completes publickey plus a zero-prompt `keyboard-interactive` step, and `BatchMode yes` blocks that path.

## 3. Environment Variables

The monitor is configured entirely through environment variables — you don't need to edit the script.

| Variable | Required | Purpose |
| --- | --- | --- |
| `SLURM_STATUS_BAR_REMOTE_USER` | usually | Cluster username when it differs from your local username |
| `SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT` | recommended | Account row to read from `sshare` |
| `SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT_<REMOTE>` | optional | Per-cluster override, e.g. `SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT_FIR` |
| `SLURM_STATUS_BAR_SSH_ALIAS_<REMOTE>` | optional | Override the SSH alias for both `squeue` and `sshare` for one logical remote |
| `SLURM_STATUS_BAR_SQUEUE_ALIAS_<REMOTE>` | optional | Override the alias used for `squeue` only |
| `SLURM_STATUS_BAR_FAIRSHARE_ALIAS_<REMOTE>` | optional | Override the alias used for `sshare` only |
| `SLURM_STATUS_BAR_DISABLE_FAIRSHARE` | optional | Disable fairshare lookups globally |
| `SLURM_STATUS_BAR_DISABLE_FAIRSHARE_<REMOTE>` | optional | Disable fairshare lookups for one logical remote |
| `SLURM_STATUS_BAR_DISABLE_PASSCODE_FALLBACK` | optional | Skip `sshpass` fallback; rely on key-based aliases |
| `SLURM_STATUS_BAR_SSHPASS_FILE` | optional | Passcode file used by `sshpass` when no ControlMaster session is active |

### Resolution rules

**Fairshare account:**

1. `SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT_<REMOTE>` wins for that remote.
2. Otherwise `SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT` is used for all remotes.
3. Otherwise the monitor auto-picks the first GPU-looking row it finds for your user.
4. If multiple rows are plausible, it warns on stderr and picks one — set the account explicitly.

If fairshare lookup fails for a cluster, the status line shows `?` for that cluster and jobs still update.

**SSH alias:**

1. `SLURM_STATUS_BAR_SQUEUE_ALIAS_<REMOTE>` is used for `squeue` if set.
2. `SLURM_STATUS_BAR_FAIRSHARE_ALIAS_<REMOTE>` is used for `sshare` if set.
3. Otherwise `SLURM_STATUS_BAR_SSH_ALIAS_<REMOTE>` is used for both.
4. Otherwise the logical remote name is used directly.

## 4. Run the Monitor Manually First

Always test manually before wiring up LaunchAgent / systemd.

### Single cluster

```bash
export SLURM_STATUS_BAR_REMOTE_USER=YOUR_CLUSTER_USERNAME
export SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT=YOUR_GPU_ACCOUNT
./scripts/slurm_monitor.sh fir
```

### Multiple clusters with per-cluster accounts

```bash
export SLURM_STATUS_BAR_REMOTE_USER=YOUR_CLUSTER_USERNAME
export SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT_FIR=YOUR_FIR_GPU_ACCOUNT
export SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT_ROR=YOUR_ROR_GPU_ACCOUNT
export SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT_NIBI=YOUR_NIBI_GPU_ACCOUNT
export SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT_TRIL=YOUR_TRIL_GPU_ACCOUNT
./scripts/slurm_monitor.sh fir ror nibi tril
```

### Automation-node mode (key-only, no passcode)

```bash
export SLURM_STATUS_BAR_REMOTE_USER=YOUR_CLUSTER_USERNAME
export SLURM_STATUS_BAR_DISABLE_PASSCODE_FALLBACK=1
export SLURM_STATUS_BAR_SQUEUE_ALIAS_FIR=robot-fir-slurm
export SLURM_STATUS_BAR_FAIRSHARE_ALIAS_FIR=robot-fir-fairshare
export SLURM_STATUS_BAR_SQUEUE_ALIAS_ROR=robot-ror-slurm
export SLURM_STATUS_BAR_FAIRSHARE_ALIAS_ROR=robot-ror-fairshare
export SLURM_STATUS_BAR_SQUEUE_ALIAS_NIBI=robot-nibi-slurm
export SLURM_STATUS_BAR_FAIRSHARE_ALIAS_NIBI=robot-nibi-fairshare
export SLURM_STATUS_BAR_SQUEUE_ALIAS_TRIL=robot-tril-slurm
export SLURM_STATUS_BAR_FAIRSHARE_ALIAS_TRIL=robot-tril-fairshare
./scripts/slurm_monitor.sh fir ror nibi tril
```

### Automation-node mode without fairshare

If `squeue` is allowed but `sshare` isn't (some robot-node wrappers don't expose it):

```bash
export SLURM_STATUS_BAR_REMOTE_USER=YOUR_CLUSTER_USERNAME
export SLURM_STATUS_BAR_DISABLE_PASSCODE_FALLBACK=1
export SLURM_STATUS_BAR_DISABLE_FAIRSHARE=1
export SLURM_STATUS_BAR_SQUEUE_ALIAS_FIR=robot-fir-slurm
export SLURM_STATUS_BAR_SQUEUE_ALIAS_ROR=robot-ror-slurm
export SLURM_STATUS_BAR_SQUEUE_ALIAS_NIBI=robot-nibi-slurm
export SLURM_STATUS_BAR_SQUEUE_ALIAS_TRIL=robot-tril-slurm
./scripts/slurm_monitor.sh fir ror nibi tril
```

### Passcode-based fallback

If your workflow uses a passcode + `sshpass`:

```bash
export SLURM_STATUS_BAR_SSHPASS_FILE="$HOME/.claude/hpc_passcode"
```

The monitor first tries `ssh -O check <remote>`. If that shared session isn't available, it falls back to `sshpass` with the configured passcode file. If you only use key-based robot aliases, set `SLURM_STATUS_BAR_DISABLE_PASSCODE_FALLBACK=1` instead.

### Verify the result

In another shell:

```bash
cat ~/.slurm_status_bar.txt
```

If the monitor is healthy:

- the file exists and changes over time
- the prefix contains one fairshare value per configured cluster
- the rest of the line contains zero or more jobs
- the four CSV history files in `$HOME` grow over time

## 5. Auto-Start on Login

### macOS — LaunchAgent

1. Copy the example plist:

    ```bash
    mkdir -p ~/Library/LaunchAgents
    cp examples/launchd/com.user.slurm-status.plist ~/Library/LaunchAgents/
    ```

1. Edit `~/Library/LaunchAgents/com.user.slurm-status.plist`:
    - the absolute path to `scripts/slurm_monitor.sh`
    - the cluster aliases in `ProgramArguments`
    - `SLURM_STATUS_BAR_REMOTE_USER`
    - `SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT` or per-cluster overrides
    - optionally `SLURM_STATUS_BAR_SSHPASS_FILE` or automation aliases

1. Load it:

    ```bash
    launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.user.slurm-status.plist
    launchctl enable "gui/$(id -u)/com.user.slurm-status"
    launchctl kickstart -k "gui/$(id -u)/com.user.slurm-status"
    ```

1. Check status and logs:

    ```bash
    launchctl print "gui/$(id -u)/com.user.slurm-status"
    tail -f /tmp/slurm-status.log
    tail -f /tmp/slurm-status.err
    ```

If you edit the plist later, reload it:

```bash
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.user.slurm-status.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.user.slurm-status.plist
```

### Linux — systemd user service

Create `~/.config/systemd/user/slurm-status.service`:

```ini
[Unit]
Description=Slurm Status Monitor
After=network.target

[Service]
Type=simple
Environment=SLURM_STATUS_BAR_REMOTE_USER=YOUR_CLUSTER_USERNAME
Environment=SLURM_STATUS_BAR_DISABLE_PASSCODE_FALLBACK=1
Environment=SLURM_STATUS_BAR_DISABLE_FAIRSHARE=1
Environment=SLURM_STATUS_BAR_SQUEUE_ALIAS_FIR=robot-fir-slurm
Environment=SLURM_STATUS_BAR_SQUEUE_ALIAS_ROR=robot-ror-slurm
Environment=SLURM_STATUS_BAR_SQUEUE_ALIAS_NIBI=robot-nibi-slurm
Environment=SLURM_STATUS_BAR_SQUEUE_ALIAS_TRIL=robot-tril-slurm
ExecStart=/absolute/path/to/vscode-slurm-status-bar/scripts/slurm_monitor.sh fir ror nibi tril
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable slurm-status.service
systemctl --user start slurm-status.service
systemctl --user status slurm-status.service
journalctl --user -u slurm-status.service -f
```

## 6. Reading the Status Line

```text
Fir: 0.372 | Ror: 0.064 | Nibi: 0.774 | train_model (R) 1:23:45 | embed_docs (PD) 2:17
```

- `Fir: 0.372` — fairshare value chosen from that cluster's `sshare` output
- `train_model (R) 1:23:45` — running job with **time remaining** from Slurm
- `embed_docs (PD) 2:17` — pending job with **elapsed pending time** counted up locally from when the monitor first saw it

Common Slurm state codes: `R` running, `PD` pending, `CG` completing, `CD` completed, `F` failed, `CA` cancelled.

## 7. The Dashboard Panel

Click the status bar item, or run **HPC Usage Dashboard: Open Dashboard** from the Command Palette.

**Top bar:**
- preset range pills (All / 24H / 7D / 30D / 90D / 1Y)
- custom start and end datetime fields
- CPU / GPU toggles
- aggregation bucket (Raw / 15m / 1h / 6h)
- cluster scope (All HPCs or a single cluster)
- overlay metric selector (any job or node metric drawn on a secondary y-axis)
- Clear Selection button

**Chart interactions:**
- hover to inspect exact values at the nearest recorded sample
- click-drag horizontally to select a window; the Selection and Job Statistics cards report net fairshare Δ, overlay-metric Δ, duration, and sample count

**Below the chart:**
- Selection summary (per-cluster Δ cards)
- Job Statistics (overall + per-cluster current values with selection deltas)
- Efficiency Metrics (Δ per CPU-hour, per GPU-hour, per distinct job, idle recovery rate, node counts)
- Lag / Correlation (best lag between fairshare and each of job count, GPU-hours remaining, schedulable GPU nodes, down GPU nodes)
- Job Event Log (submit / start / end / queue-change events in the current window)

## Configuration Details

### Refresh timing

- Remote refresh interval: **60 seconds** (each cluster polled once per cycle)
- Local status bar update interval: **1 second**

To change the remote refresh interval, edit `REFRESH_INTERVAL` in [scripts/slurm_monitor.py](scripts/slurm_monitor.py).

### How jobs are merged

- Jobs from all configured remotes are merged into one line.
- Job entries don't include the cluster name in the status line, but internally the monitor keys jobs by `remote:jobid` to avoid collisions between clusters.

## Troubleshooting

### VS Code shows `No Slurm status`

The status file doesn't exist yet. Check:

```bash
cat ~/.slurm_status_bar.txt
ps aux | grep slurm_monitor
```

Then run the monitor manually to see errors on stderr:

```bash
./scripts/slurm_monitor.sh fir ror nibi tril
```

### Fairshare shows `?`

Usually one of:

- `sshare` failed on that cluster
- wrong remote username
- the monitor can't disambiguate your fairshare account row
- fairshare is intentionally disabled for that cluster

Test directly and then set `SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT` (or a per-remote override):

```bash
ssh fir "sshare -u YOUR_CLUSTER_USERNAME -l -P"
```

### Jobs don't appear even though `squeue` works manually

Your local and remote usernames differ:

```bash
echo "$USER"
ssh fir "whoami"
```

Set `SLURM_STATUS_BAR_REMOTE_USER` to the cluster username.

### SSH prompts appear when running headlessly

Options, in order of preference:

1. use key-based SSH and pre-warm a ControlMaster session before the monitor runs
2. use robot-node aliases with key-only auth and `SLURM_STATUS_BAR_DISABLE_PASSCODE_FALLBACK=1`
3. install `sshpass`, put a passcode in a `chmod 600` file, and set `SLURM_STATUS_BAR_SSHPASS_FILE`

### LaunchAgent starts but immediately exits

```bash
tail -100 /tmp/slurm-status.err
launchctl print "gui/$(id -u)/com.user.slurm-status"
```

Common causes: wrong script path, missing `python3`, missing env vars, or an SSH alias that works in your interactive shell but not from LaunchAgent because `~/.ssh/config` or PATH assumptions differ.

### Stale status line

If the monitor process died but the file is still there:

```bash
pkill -f slurm_monitor.py
rm -f ~/.slurm_status_bar.txt
```

Then restart the monitor manually.

### Dashboard panel is empty

Confirm the CSV history files exist and have at least a header + one data row:

```bash
ls -la ~/.slurm_*_history.csv
head -3 ~/.slurm_fairshare_history.csv
```

If they're empty, the monitor hasn't completed a full refresh cycle yet — wait one refresh interval (~60 s) and reopen the dashboard.

## Development

```bash
git clone https://github.com/devon7y/vscode-slurm-status-bar.git
cd vscode-slurm-status-bar
npm install
npm run watch      # continuous compilation while you edit
```

Then press `F5` in VS Code to launch an Extension Development Host.

To produce a `.vsix`:

```bash
npm run compile
npx @vscode/vsce package
```

## License

MIT. See [LICENSE](LICENSE).

## Support

- Issues: [GitHub Issues](https://github.com/devon7y/vscode-slurm-status-bar/issues)
- Discussions: [GitHub Discussions](https://github.com/devon7y/vscode-slurm-status-bar/discussions)
