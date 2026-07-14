#!/usr/bin/env python3

from __future__ import annotations

import csv
import getpass
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime


STATUS_FILE = pathlib.Path.home() / ".slurm_status_bar.txt"
FAIRSHARE_HISTORY_FILE = pathlib.Path.home() / ".slurm_fairshare_history.csv"
JOB_HISTORY_FILE = pathlib.Path.home() / ".slurm_job_history.csv"
JOB_SNAPSHOT_HISTORY_FILE = pathlib.Path.home() / ".slurm_job_snapshot_history.csv"
NODE_HISTORY_FILE = pathlib.Path.home() / ".slurm_node_history.csv"
DEFAULT_PASSCODE_FILE = pathlib.Path.home() / ".claude" / "hpc_passcode"
PASSCODE_FILE = pathlib.Path(
    os.environ.get("SLURM_STATUS_BAR_SSHPASS_FILE", str(DEFAULT_PASSCODE_FILE))
)
FAIRSHARE_ACCOUNT_ENV = "SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT"
GENERIC_ALIAS_ENV = "SLURM_STATUS_BAR_SSH_ALIAS"
SQUEUE_ALIAS_ENV = "SLURM_STATUS_BAR_SQUEUE_ALIAS"
FAIRSHARE_ALIAS_ENV = "SLURM_STATUS_BAR_FAIRSHARE_ALIAS"
DISABLE_FAIRSHARE_ENV = "SLURM_STATUS_BAR_DISABLE_FAIRSHARE"
DISABLE_PASSCODE_FALLBACK_ENV = "SLURM_STATUS_BAR_DISABLE_PASSCODE_FALLBACK"
REFRESH_INTERVAL = 60
TIME_PATTERN = re.compile(r"^(?:(\d+)-)?(\d+(?::\d+){0,2})$")
REMOTE_LABELS = {
    "fir": "Fir",
    "ror": "Ror",
    "nibi": "Nibi",
    "tril": "Tril",
    "nar": "Nar",
}
HISTORY_REMOTES = ("fir", "ror", "nibi", "tril", "nar")
FAIRSHARE_RESOURCES = ("cpu", "gpu")
FAIRSHARE_HISTORY_COLUMNS = [
    "timestamp",
    *[
        f"{remote}_{resource}"
        for remote in HISTORY_REMOTES
        for resource in FAIRSHARE_RESOURCES
    ],
]
JOB_HISTORY_COLUMNS = [
    "timestamp",
    "total_jobs",
    "running_jobs",
    "pending_jobs",
    "other_jobs",
    "total_elapsed_hours",
    "total_remaining_hours",
    "total_time_limit_hours",
    "total_cpu_count",
    "total_gpu_count",
    "total_cpu_hours_elapsed",
    "total_cpu_hours_remaining",
    "total_cpu_hours_limit",
    "total_gpu_hours_elapsed",
    "total_gpu_hours_remaining",
    "total_gpu_hours_limit",
    *[
        field
        for remote in HISTORY_REMOTES
        for field in (
            f"{remote}_jobs",
            f"{remote}_running_jobs",
            f"{remote}_pending_jobs",
            f"{remote}_other_jobs",
            f"{remote}_elapsed_hours",
            f"{remote}_remaining_hours",
            f"{remote}_time_limit_hours",
            f"{remote}_cpu_count",
            f"{remote}_gpu_count",
            f"{remote}_cpu_hours_elapsed",
            f"{remote}_cpu_hours_remaining",
            f"{remote}_cpu_hours_limit",
            f"{remote}_gpu_hours_elapsed",
            f"{remote}_gpu_hours_remaining",
            f"{remote}_gpu_hours_limit",
        )
    ],
]
JOB_SNAPSHOT_HISTORY_COLUMNS = [
    "timestamp",
    "remote",
    "job_id",
    "name",
    "state",
    "elapsed_hours",
    "remaining_hours",
    "time_limit_hours",
    "num_nodes",
    "num_cpus",
    "num_gpus",
    "cpu_hours_elapsed",
    "cpu_hours_remaining",
    "cpu_hours_limit",
    "gpu_hours_elapsed",
    "gpu_hours_remaining",
    "gpu_hours_limit",
]
NODE_RESOURCES = (
    "total_gpu_nodes",
    "schedulable_gpu_nodes",
    "down_gpu_nodes",
    "drain_gpu_nodes",
)
NODE_HISTORY_COLUMNS = [
    "timestamp",
    *[
        f"{remote}_{resource}"
        for remote in HISTORY_REMOTES
        for resource in NODE_RESOURCES
    ],
]


@dataclass
class JobState:
    remote: str
    job_id: str
    name: str
    state: str
    time_left_seconds: int
    elapsed_seconds: int = 0
    time_limit_seconds: int = 0
    num_nodes: int = 0
    num_cpus: int = 0
    num_gpus: int = 0
    pending_elapsed_seconds: int = 0


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def env_key_for_remote(prefix: str, remote: str) -> str:
    remote_key = re.sub(r"[^A-Za-z0-9]+", "_", remote).upper()
    return f"{prefix}_{remote_key}"


def env_flag_enabled(key: str) -> bool:
    return os.environ.get(key, "").strip().lower() in {"1", "true", "yes", "on"}


def ssh_alias_for_remote(remote: str, purpose: str) -> str:
    purpose_env = {
        "squeue": SQUEUE_ALIAS_ENV,
        "fairshare": FAIRSHARE_ALIAS_ENV,
    }[purpose]
    return (
        os.environ.get(env_key_for_remote(purpose_env, remote))
        or os.environ.get(env_key_for_remote(GENERIC_ALIAS_ENV, remote))
        or remote
    )


def fairshare_disabled_for_remote(remote: str) -> bool:
    return env_flag_enabled(DISABLE_FAIRSHARE_ENV) or env_flag_enabled(
        env_key_for_remote(DISABLE_FAIRSHARE_ENV, remote)
    )


def passcode_fallback_disabled(remote: str) -> bool:
    return env_flag_enabled(DISABLE_PASSCODE_FALLBACK_ENV) or remote.startswith(
        "robot-"
    )


def run_command(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True)


def find_sshpass() -> str | None:
    candidates = [
        shutil.which("sshpass"),
        "/opt/homebrew/bin/sshpass",
        "/usr/local/bin/sshpass",
        "/opt/local/bin/sshpass",
    ]
    for candidate in candidates:
        if candidate and os.path.exists(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def ensure_connection(remote: str) -> bool:
    check = run_command(["ssh", "-O", "check", remote])
    if check.returncode == 0:
        return True

    if passcode_fallback_disabled(remote):
        return True

    if not PASSCODE_FILE.exists():
        return False

    sshpass = find_sshpass()
    if not sshpass:
        return False

    reconnect = run_command(
        [
            sshpass,
            "-P",
            "Passcode",
            "-f",
            str(PASSCODE_FILE),
            "ssh",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-fN",
            remote,
        ]
    )
    if reconnect.returncode != 0:
        return False

    recheck = run_command(["ssh", "-O", "check", remote])
    return recheck.returncode == 0


def time_to_seconds(time_str: str) -> int:
    value = time_str.strip()
    if not value or value in {"N/A", "UNLIMITED"}:
        return 0

    match = TIME_PATTERN.fullmatch(value)
    if not match:
        return 0

    total_seconds = 0
    days = int(match.group(1) or 0)
    total_seconds += days * 86400

    parts = [int(part) for part in match.group(2).split(":")]
    if len(parts) == 3:
        hours, minutes, seconds = parts
        total_seconds += hours * 3600 + minutes * 60 + seconds
    elif len(parts) == 2:
        minutes, seconds = parts
        total_seconds += minutes * 60 + seconds
    elif len(parts) == 1:
        total_seconds += parts[0]

    return total_seconds


def seconds_to_time(seconds: int) -> str:
    if seconds <= 0:
        return "0:00"

    days, remainder = divmod(seconds, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes, secs = divmod(remainder, 60)

    if days > 0:
        return f"{days}-{hours:02d}:{minutes:02d}:{secs:02d}"
    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def parse_int(value: str) -> int:
    try:
        return int(value.strip())
    except (TypeError, ValueError, AttributeError):
        return 0


def parse_gpu_count(value: str) -> int:
    gres = value.strip()
    if not gres or gres.upper() == "N/A":
        return 0

    total = 0
    for token in gres.split(","):
        item = token.strip().lower()
        if "gpu" not in item:
            continue

        match = re.search(r"gpu(?::[\w.\-]+)*:(\d+)(?:\(|$)", item)
        if match:
            total += int(match.group(1))
            continue

        match = re.search(r"gpu=(\d+)", item)
        if match:
            total += int(match.group(1))

    return total


def hours(value: int) -> float:
    return value / 3600 if value > 0 else 0.0


def format_hours(value: float) -> str:
    return f"{value:.3f}"


def fetch_jobs(remote: str, user: str) -> list[JobState]:
    ssh_alias = ssh_alias_for_remote(remote, "squeue")
    if not ensure_connection(ssh_alias):
        raise RuntimeError(f"unable to establish SSH connection to {ssh_alias}")

    remote_cmd = (
        f"squeue -u {shlex.quote(user)} --noheader "
        "-o '%i|%j|%t|%L|%M|%l|%D|%C|%b'"
    )
    result = run_command(["ssh", ssh_alias, remote_cmd])
    if result.returncode != 0:
        details = (result.stderr or result.stdout).strip()
        raise RuntimeError(details or f"squeue failed on {ssh_alias}")

    jobs: list[JobState] = []
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split("|", 8)
        if len(parts) != 9:
            continue
        (
            job_id,
            name,
            state,
            time_left,
            elapsed,
            time_limit,
            num_nodes,
            num_cpus,
            gres,
        ) = parts
        job_id = job_id.strip().strip("'")
        name = name.strip().strip("'")
        state = state.strip().strip("'")
        time_left = time_left.strip().strip("'")
        elapsed = elapsed.strip().strip("'")
        time_limit = time_limit.strip().strip("'")
        num_nodes = num_nodes.strip().strip("'")
        num_cpus = num_cpus.strip().strip("'")
        gres = gres.strip().strip("'")
        jobs.append(
            JobState(
                remote=remote,
                job_id=job_id,
                name=name,
                state=state,
                time_left_seconds=time_to_seconds(time_left),
                elapsed_seconds=time_to_seconds(elapsed),
                time_limit_seconds=time_to_seconds(time_limit),
                num_nodes=parse_int(num_nodes),
                num_cpus=parse_int(num_cpus),
                num_gpus=parse_gpu_count(gres),
            )
        )
    return jobs


def format_fairshare(raw_value: str) -> str:
    try:
        return f"{float(raw_value):.3f}"
    except ValueError:
        return raw_value


def preferred_account_base(remote: str) -> str:
    preferred_account = (
        os.environ.get(env_key_for_remote(FAIRSHARE_ACCOUNT_ENV, remote))
        or os.environ.get(FAIRSHARE_ACCOUNT_ENV)
        or ""
    ).strip()
    preferred_lower = preferred_account.lower()
    if preferred_lower.endswith("_cpu") or preferred_lower.endswith("_gpu"):
        return preferred_account[:-4]
    return preferred_account


def select_fairshare_row(
    matching_rows: list[tuple[str, str]],
    remote: str,
    resource: str,
    user: str,
) -> str:
    preferred_account = (
        os.environ.get(env_key_for_remote(FAIRSHARE_ACCOUNT_ENV, remote))
        or os.environ.get(FAIRSHARE_ACCOUNT_ENV)
        or ""
    ).strip()
    preferred_account_lower = preferred_account.lower()
    preferred_base = preferred_account_base(remote)
    preferred_name = (
        f"{preferred_base}_{resource}".lower() if preferred_base else ""
    )

    if preferred_name:
        for account, fairshare in matching_rows:
            if account.lower() == preferred_name:
                return format_fairshare(fairshare)
        if preferred_base:
            for account, fairshare in matching_rows:
                if account.lower() == preferred_base.lower():
                    return format_fairshare(fairshare)
        if preferred_account_lower:
            for account, fairshare in matching_rows:
                if account.lower() == preferred_account_lower:
                    return format_fairshare(fairshare)
        raise RuntimeError(
            f"fairshare row for account {preferred_name} not found on "
            f"{ssh_alias_for_remote(remote, 'fairshare')}"
        )

    resource_rows = [
        (account, fairshare)
        for account, fairshare in matching_rows
        if account.lower().endswith(f"_{resource}")
    ]
    if not resource_rows:
        # Some clusters (e.g. Trillium's separate CPU/GPU subclusters) expose a
        # single unsuffixed account rather than *_cpu / *_gpu rows; use it for
        # whichever resource we are resolving.
        generic_rows = [
            (account, fairshare)
            for account, fairshare in matching_rows
            if not account.lower().endswith("_cpu")
            and not account.lower().endswith("_gpu")
        ]
        if len(generic_rows) == 1:
            selected_account, selected_fairshare = generic_rows[0]
            log(
                "Warning: using unsuffixed fairshare row "
                f"{selected_account} for {remote} {resource} fairshare. "
                f"Set {FAIRSHARE_ACCOUNT_ENV} or "
                f"{env_key_for_remote(FAIRSHARE_ACCOUNT_ENV, remote)} "
                "to override."
            )
            return format_fairshare(selected_fairshare)
        raise RuntimeError(
            f"no {resource} fairshare rows found for user {user} on "
            f"{ssh_alias_for_remote(remote, 'fairshare')}"
        )

    selected_account, selected_fairshare = resource_rows[0]
    if len(resource_rows) > 1:
        log(
            "Warning: multiple "
            f"{resource} fairshare rows matched on "
            f"{ssh_alias_for_remote(remote, 'fairshare')}; using {selected_account}. "
            f"Set {FAIRSHARE_ACCOUNT_ENV} or "
            f"{env_key_for_remote(FAIRSHARE_ACCOUNT_ENV, remote)} "
            "to override."
        )
    return format_fairshare(selected_fairshare)


def fairshare_alias_for_resource(
    remote: str, resource: str, base_alias: str
) -> str:
    # Trillium splits CPU and GPU across two independent Slurm clusters, so their
    # fairshare must be read from different automation nodes. A per-resource alias
    # (e.g. SLURM_STATUS_BAR_FAIRSHARE_ALIAS_CPU_TRIL) overrides the base alias for
    # just that resource; everything else keeps using one sshare call.
    prefix = f"{FAIRSHARE_ALIAS_ENV}_{resource.upper()}"
    return os.environ.get(env_key_for_remote(prefix, remote)) or base_alias


def fetch_fairshare_rows(ssh_alias: str, user: str) -> list[tuple[str, str]]:
    if not ensure_connection(ssh_alias):
        raise RuntimeError(f"unable to establish SSH connection to {ssh_alias}")

    remote_cmd = f"sshare -u {shlex.quote(user)} -l -P"
    result = run_command(["ssh", ssh_alias, remote_cmd])
    if result.returncode != 0:
        details = (result.stderr or result.stdout).strip()
        raise RuntimeError(details or f"sshare failed on {ssh_alias}")

    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if len(lines) < 2:
        raise RuntimeError(f"unexpected sshare output on {ssh_alias}")

    header = [column.strip() for column in lines[0].split("|")]
    try:
        account_idx = header.index("Account")
        user_idx = header.index("User")
        fairshare_idx = header.index("FairShare")
    except ValueError as exc:
        raise RuntimeError(f"missing sshare column on {ssh_alias}: {exc}") from exc

    matching_rows: list[tuple[str, str]] = []
    for line in lines[1:]:
        columns = [column.strip() for column in line.split("|")]
        if len(columns) <= max(account_idx, user_idx, fairshare_idx):
            continue
        if columns[user_idx] != user:
            continue
        matching_rows.append(
            (columns[account_idx], columns[fairshare_idx].strip())
        )

    if not matching_rows:
        raise RuntimeError(f"no fairshare rows found for user {user} on {ssh_alias}")

    return matching_rows


def fetch_fairshare(remote: str, user: str) -> dict[str, str]:
    if fairshare_disabled_for_remote(remote):
        return {resource: "n/a" for resource in FAIRSHARE_RESOURCES}

    base_alias = ssh_alias_for_remote(remote, "fairshare")
    rows_by_alias: dict[str, list[tuple[str, str]] | None] = {}
    selected: dict[str, str] = {}

    for resource in FAIRSHARE_RESOURCES:
        alias = fairshare_alias_for_resource(remote, resource, base_alias)
        if alias not in rows_by_alias:
            try:
                rows_by_alias[alias] = fetch_fairshare_rows(alias, user)
            except RuntimeError as exc:
                log(
                    f"Warning: failed to fetch {resource} fairshare for "
                    f"{remote} via {alias}: {exc}"
                )
                rows_by_alias[alias] = None

        matching_rows = rows_by_alias[alias]
        if not matching_rows:
            selected[resource] = "n/a"
            continue

        try:
            selected[resource] = select_fairshare_row(
                matching_rows, remote, resource, user
            )
        except RuntimeError as exc:
            log(f"Warning: failed to fetch {resource} fairshare for {remote}: {exc}")
            selected[resource] = "n/a"
    return selected


def fetch_node_availability(remote: str) -> dict[str, str]:
    ssh_alias = ssh_alias_for_remote(remote, "fairshare")
    if not ensure_connection(ssh_alias):
        raise RuntimeError(f"unable to establish SSH connection to {ssh_alias}")

    remote_cmd = "scontrol show node -o"
    result = run_command(["ssh", ssh_alias, remote_cmd])
    if result.returncode != 0:
        details = (result.stderr or result.stdout).strip()
        raise RuntimeError(details or f"scontrol show node failed on {ssh_alias}")

    counts = {
        "total_gpu_nodes": 0,
        "schedulable_gpu_nodes": 0,
        "down_gpu_nodes": 0,
        "drain_gpu_nodes": 0,
    }
    down_tokens = ("down", "fail", "maint")
    drain_tokens = ("drain", "drng", "drained")

    for line in result.stdout.splitlines():
        if not line.strip():
            continue

        gres_match = re.search(r"\bGres=([^\s]+)", line)
        partitions_match = re.search(r"\bPartitions=([^\s]+)", line)
        gres_lower = (gres_match.group(1) if gres_match else "").strip().lower()
        partitions_lower = (
            partitions_match.group(1) if partitions_match else ""
        ).strip().lower()

        if "gpu" not in gres_lower and "gpu" not in partitions_lower:
            continue

        counts["total_gpu_nodes"] += 1
        state_match = re.search(r"\bState=([^\s]+)", line)
        state_lower = (
            state_match.group(1).strip().lower() if state_match else ""
        )
        if any(token in state_lower for token in drain_tokens):
            counts["drain_gpu_nodes"] += 1
            continue
        if any(token in state_lower for token in down_tokens):
            counts["down_gpu_nodes"] += 1
            continue
        counts["schedulable_gpu_nodes"] += 1

    return {key: str(value) for key, value in counts.items()}

def migrate_wide_history_file(
    file_path: pathlib.Path,
    expected_header: list[str],
    context: str,
) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    if not file_path.exists() or file_path.stat().st_size == 0:
        return

    with file_path.open("r", newline="", encoding="utf-8") as handle:
        rows = list(csv.reader(handle))

    if not rows:
        return

    header = rows[0]
    if header == expected_header:
        return

    expected_columns = set(expected_header)
    if not header or header[0] != "timestamp":
        log(
            f"Warning: unrecognized {context} header; "
            f"expected first column to be timestamp, got {header}"
        )
        return

    unexpected = [column for column in header if column not in expected_columns]
    if unexpected:
        log(
            f"Warning: unrecognized {context} columns {unexpected}; "
            f"expected subset of {expected_header}"
        )
        return

    migrated_rows: list[list[str]] = [expected_header]
    for row in rows[1:]:
        row_map = {
            header[index]: row[index] if index < len(row) else ""
            for index in range(len(header))
        }
        migrated_rows.append([row_map.get(column, "") for column in expected_header])

    with file_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerows(migrated_rows)


def migrate_fairshare_history() -> None:
    FAIRSHARE_HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    if (
        not FAIRSHARE_HISTORY_FILE.exists()
        or FAIRSHARE_HISTORY_FILE.stat().st_size == 0
    ):
        return

    with FAIRSHARE_HISTORY_FILE.open("r", newline="", encoding="utf-8") as handle:
        rows = list(csv.reader(handle))

    if not rows:
        return

    header = rows[0]
    if header == FAIRSHARE_HISTORY_COLUMNS:
        return

    legacy_header = ["timestamp", "fir", "ror", "nibi", "tril"]
    if header == legacy_header:
        migrated_rows: list[list[str]] = [FAIRSHARE_HISTORY_COLUMNS]
        for row in rows[1:]:
            values = {
                remote: row[index + 1] if index + 1 < len(row) else ""
                for index, remote in enumerate(legacy_header[1:])
            }
            migrated_rows.append(
                [
                    row[0] if row else "",
                    *[
                        values.get(remote, "") if resource == "gpu" else ""
                        for remote in HISTORY_REMOTES
                        for resource in FAIRSHARE_RESOURCES
                    ],
                ]
            )

        with FAIRSHARE_HISTORY_FILE.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerows(migrated_rows)
        return

    migrate_wide_history_file(
        FAIRSHARE_HISTORY_FILE,
        FAIRSHARE_HISTORY_COLUMNS,
        "fairshare history",
    )


def append_fairshare_history(snapshot: dict[str, dict[str, str]]) -> None:
    FAIRSHARE_HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    migrate_fairshare_history()
    write_header = (
        not FAIRSHARE_HISTORY_FILE.exists()
        or FAIRSHARE_HISTORY_FILE.stat().st_size == 0
    )

    row = [
        datetime.now().astimezone().isoformat(timespec="seconds"),
        *[
            ""
            if snapshot.get(remote, {}).get(resource, "") in {"", "n/a", "?"}
            else snapshot.get(remote, {}).get(resource, "")
            for remote in HISTORY_REMOTES
            for resource in FAIRSHARE_RESOURCES
        ],
    ]

    with FAIRSHARE_HISTORY_FILE.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        if write_header:
            writer.writerow(FAIRSHARE_HISTORY_COLUMNS)
        writer.writerow(row)


def append_node_history(snapshot: dict[str, dict[str, str]]) -> None:
    NODE_HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    migrate_wide_history_file(
        NODE_HISTORY_FILE,
        NODE_HISTORY_COLUMNS,
        "node history",
    )
    write_header = (
        not NODE_HISTORY_FILE.exists()
        or NODE_HISTORY_FILE.stat().st_size == 0
    )

    row = [
        datetime.now().astimezone().isoformat(timespec="seconds"),
        *[
            snapshot.get(remote, {}).get(resource, "")
            for remote in HISTORY_REMOTES
            for resource in NODE_RESOURCES
        ],
    ]

    with NODE_HISTORY_FILE.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        if write_header:
            writer.writerow(NODE_HISTORY_COLUMNS)
        writer.writerow(row)


def zero_job_stats() -> dict[str, float]:
    return {
        "jobs": 0.0,
        "running_jobs": 0.0,
        "pending_jobs": 0.0,
        "other_jobs": 0.0,
        "elapsed_hours": 0.0,
        "remaining_hours": 0.0,
        "time_limit_hours": 0.0,
        "cpu_count": 0.0,
        "gpu_count": 0.0,
        "cpu_hours_elapsed": 0.0,
        "cpu_hours_remaining": 0.0,
        "cpu_hours_limit": 0.0,
        "gpu_hours_elapsed": 0.0,
        "gpu_hours_remaining": 0.0,
        "gpu_hours_limit": 0.0,
    }


def append_job_history(
    jobs_by_key: dict[str, JobState],
    remotes: list[str],
) -> None:
    JOB_HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    migrate_wide_history_file(
        JOB_HISTORY_FILE,
        JOB_HISTORY_COLUMNS,
        "job history",
    )
    write_header = (
        not JOB_HISTORY_FILE.exists()
        or JOB_HISTORY_FILE.stat().st_size == 0
    )

    per_remote = {remote: zero_job_stats() for remote in HISTORY_REMOTES}
    totals = zero_job_stats()

    for job in jobs_by_key.values():
        stats = per_remote.setdefault(job.remote, zero_job_stats())
        stats["jobs"] += 1
        totals["jobs"] += 1

        if job.state == "R":
            stats["running_jobs"] += 1
            totals["running_jobs"] += 1
        elif job.state == "PD":
            stats["pending_jobs"] += 1
            totals["pending_jobs"] += 1
        else:
            stats["other_jobs"] += 1
            totals["other_jobs"] += 1

        elapsed_hours = hours(job.elapsed_seconds)
        remaining_hours = hours(job.time_left_seconds)
        time_limit_hours = hours(job.time_limit_seconds)
        cpu_count = float(job.num_cpus)
        gpu_count = float(job.num_gpus)
        cpu_hours_elapsed = elapsed_hours * job.num_cpus
        cpu_hours_remaining = remaining_hours * job.num_cpus
        cpu_hours_limit = time_limit_hours * job.num_cpus
        gpu_hours_elapsed = elapsed_hours * job.num_gpus
        gpu_hours_remaining = remaining_hours * job.num_gpus
        gpu_hours_limit = time_limit_hours * job.num_gpus

        for target in (stats, totals):
            target["elapsed_hours"] += elapsed_hours
            target["remaining_hours"] += remaining_hours
            target["time_limit_hours"] += time_limit_hours
            target["cpu_count"] += cpu_count
            target["gpu_count"] += gpu_count
            target["cpu_hours_elapsed"] += cpu_hours_elapsed
            target["cpu_hours_remaining"] += cpu_hours_remaining
            target["cpu_hours_limit"] += cpu_hours_limit
            target["gpu_hours_elapsed"] += gpu_hours_elapsed
            target["gpu_hours_remaining"] += gpu_hours_remaining
            target["gpu_hours_limit"] += gpu_hours_limit

    row = [
        datetime.now().astimezone().isoformat(timespec="seconds"),
        str(int(totals["jobs"])),
        str(int(totals["running_jobs"])),
        str(int(totals["pending_jobs"])),
        str(int(totals["other_jobs"])),
        format_hours(totals["elapsed_hours"]),
        format_hours(totals["remaining_hours"]),
        format_hours(totals["time_limit_hours"]),
        str(int(totals["cpu_count"])),
        str(int(totals["gpu_count"])),
        format_hours(totals["cpu_hours_elapsed"]),
        format_hours(totals["cpu_hours_remaining"]),
        format_hours(totals["cpu_hours_limit"]),
        format_hours(totals["gpu_hours_elapsed"]),
        format_hours(totals["gpu_hours_remaining"]),
        format_hours(totals["gpu_hours_limit"]),
        *[
            value
            for remote in HISTORY_REMOTES
            for value in (
                str(int(per_remote[remote]["jobs"])),
                str(int(per_remote[remote]["running_jobs"])),
                str(int(per_remote[remote]["pending_jobs"])),
                str(int(per_remote[remote]["other_jobs"])),
                format_hours(per_remote[remote]["elapsed_hours"]),
                format_hours(per_remote[remote]["remaining_hours"]),
                format_hours(per_remote[remote]["time_limit_hours"]),
                str(int(per_remote[remote]["cpu_count"])),
                str(int(per_remote[remote]["gpu_count"])),
                format_hours(per_remote[remote]["cpu_hours_elapsed"]),
                format_hours(per_remote[remote]["cpu_hours_remaining"]),
                format_hours(per_remote[remote]["cpu_hours_limit"]),
                format_hours(per_remote[remote]["gpu_hours_elapsed"]),
                format_hours(per_remote[remote]["gpu_hours_remaining"]),
                format_hours(per_remote[remote]["gpu_hours_limit"]),
            )
        ],
    ]

    with JOB_HISTORY_FILE.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        if write_header:
            writer.writerow(JOB_HISTORY_COLUMNS)
        writer.writerow(row)


def append_job_snapshot_history(jobs_by_key: dict[str, JobState]) -> None:
    JOB_SNAPSHOT_HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    write_header = (
        not JOB_SNAPSHOT_HISTORY_FILE.exists()
        or JOB_SNAPSHOT_HISTORY_FILE.stat().st_size == 0
    )

    timestamp = datetime.now().astimezone().isoformat(timespec="seconds")
    rows = []
    for job in sorted(
        jobs_by_key.values(),
        key=lambda item: (item.remote, item.job_id, item.name.lower()),
    ):
        elapsed_hours = hours(job.elapsed_seconds)
        remaining_hours = hours(job.time_left_seconds)
        time_limit_hours = hours(job.time_limit_seconds)
        rows.append(
            [
                timestamp,
                job.remote,
                job.job_id,
                job.name,
                job.state,
                format_hours(elapsed_hours),
                format_hours(remaining_hours),
                format_hours(time_limit_hours),
                str(job.num_nodes),
                str(job.num_cpus),
                str(job.num_gpus),
                format_hours(elapsed_hours * job.num_cpus),
                format_hours(remaining_hours * job.num_cpus),
                format_hours(time_limit_hours * job.num_cpus),
                format_hours(elapsed_hours * job.num_gpus),
                format_hours(remaining_hours * job.num_gpus),
                format_hours(time_limit_hours * job.num_gpus),
            ]
        )

    with JOB_SNAPSHOT_HISTORY_FILE.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        if write_header:
            writer.writerow(JOB_SNAPSHOT_HISTORY_COLUMNS)
        writer.writerows(rows)


def refresh_jobs(
    jobs_by_key: dict[str, JobState],
    fairshare_by_remote: dict[str, str],
    remotes: list[str],
    user: str,
) -> tuple[dict[str, dict[str, str]], dict[str, dict[str, str]]]:
    fairshare_snapshot = {
        remote: {resource: "" for resource in FAIRSHARE_RESOURCES}
        for remote in HISTORY_REMOTES
    }
    node_snapshot = {
        remote: {resource: "" for resource in NODE_RESOURCES}
        for remote in HISTORY_REMOTES
    }

    for remote in remotes:
        try:
            jobs = fetch_jobs(remote, user)
        except Exception as exc:  # noqa: BLE001
            log(f"Warning: failed to query {remote}: {exc}")
            fairshare_by_remote[remote] = "?"
            stale_keys = [
                job_key
                for job_key in jobs_by_key
                if job_key.startswith(f"{remote}:")
            ]
            for stale_key in stale_keys:
                jobs_by_key.pop(stale_key, None)
            continue

        try:
            fairshare = fetch_fairshare(remote, user)
            fairshare_by_remote[remote] = fairshare["gpu"]
            fairshare_snapshot[remote] = fairshare
        except Exception as exc:  # noqa: BLE001
            log(f"Warning: failed to fetch fairshare for {remote}: {exc}")
            fairshare_by_remote[remote] = "?"

        try:
            node_snapshot[remote] = fetch_node_availability(remote)
        except Exception as exc:  # noqa: BLE001
            log(f"Warning: failed to fetch node availability for {remote}: {exc}")

        seen_keys: set[str] = set()
        for job in jobs:
            job_key = f"{remote}:{job.job_id}"
            seen_keys.add(job_key)

            previous = jobs_by_key.get(job_key)
            pending_elapsed_seconds = 0
            if job.state == "PD" and previous and previous.state == "PD":
                pending_elapsed_seconds = previous.pending_elapsed_seconds

            job.pending_elapsed_seconds = pending_elapsed_seconds
            jobs_by_key[job_key] = job

        stale_keys = [
            job_key
            for job_key in jobs_by_key
            if job_key.startswith(f"{remote}:") and job_key not in seen_keys
        ]
        for stale_key in stale_keys:
            jobs_by_key.pop(stale_key, None)

    return fairshare_snapshot, node_snapshot


def tick_jobs(jobs_by_key: dict[str, JobState]) -> None:
    for job in jobs_by_key.values():
        if job.state == "PD":
            job.pending_elapsed_seconds += 1
        else:
            job.elapsed_seconds += 1
            if job.time_left_seconds > 0:
                job.time_left_seconds -= 1


def build_output(
    jobs_by_key: dict[str, JobState],
    fairshare_by_remote: dict[str, str],
    remotes: list[str],
) -> str:
    parts: list[str] = []

    for remote in remotes:
        if fairshare_disabled_for_remote(remote):
            continue
        label = REMOTE_LABELS.get(remote, remote)
        fairshare = fairshare_by_remote.get(remote, "?")
        parts.append(f"{label}: {fairshare}")

    if not jobs_by_key:
        parts.append("No active jobs")
        return " | ".join(parts)

    sorted_jobs = sorted(
        jobs_by_key.values(),
        key=lambda job: (job.name.lower(), job.state, job.time_left_seconds),
    )

    for job in sorted_jobs:
        seconds = (
            job.pending_elapsed_seconds
            if job.state == "PD"
            else job.time_left_seconds
        )
        parts.append(f"{job.name} ({job.state}) {seconds_to_time(seconds)}")
    return " | ".join(parts)


def write_status(output: str) -> None:
    temp_path = STATUS_FILE.with_suffix(".txt.tmp")
    temp_path.write_text(output + "\n", encoding="utf-8")
    temp_path.replace(STATUS_FILE)


def main() -> int:
    remotes = sys.argv[1:] or ["fir", "ror", "nibi", "tril", "nar"]
    user = os.environ.get("SLURM_STATUS_BAR_REMOTE_USER", getpass.getuser())
    jobs_by_key: dict[str, JobState] = {}
    fairshare_by_remote: dict[str, str] = {}
    counter = 0

    while True:
        if counter <= 0:
            fairshare_snapshot, node_snapshot = refresh_jobs(
                jobs_by_key, fairshare_by_remote, remotes, user
            )
            append_fairshare_history(fairshare_snapshot)
            append_node_history(node_snapshot)
            append_job_history(jobs_by_key, remotes)
            append_job_snapshot_history(jobs_by_key)
            counter = REFRESH_INTERVAL

        write_status(build_output(jobs_by_key, fairshare_by_remote, remotes))
        tick_jobs(jobs_by_key)
        counter -= 1
        time.sleep(1)


if __name__ == "__main__":
    raise SystemExit(main())
