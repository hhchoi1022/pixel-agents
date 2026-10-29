#!/usr/bin/env python3
"""System stats for a remote host's server-room racks, written to a shared file.

Runs ON the remote host (e.g. Lyman). Every interval it samples /proc and the
given mounts and atomically replaces a JSON file on storage the Pixel Agents
server can read (NFS), which server/src/systemStats.ts picks up through the
`remotes` entry of ~/.pixel-agents/server-room.json. No ports, no SSH: the
file is the whole interface, and its `generatedAt` going stale is how the
office notices this script (or the host) stopped.

The payload mirrors the local SystemStatsPayload (cpuPercent, ramUsedBytes,
ramTotalBytes, ioRead/WriteBytesPerSec, disks, users). Stdlib only, Python 3.6+.

    python3 remote-system-stats.py --out /lyman/data1/factory_hhchoi/.pixel-agents/lyman-stats.json \
        --mount /lyman/data1 --mount /lyman/data2

Keep it running with nohup or `crontab -e` → `@reboot python3 <this> --out ...`.
"""
import argparse
import json
import os
import pwd
import re
import socket
import time

SCHEMA = "pixel-agents-system-stats/1"
USER_SAMPLE_EVERY_TICKS = 3   # full /proc scan every ~3 intervals
DISK_REFRESH_SEC = 30
TOP_USERS = 8
# Whole physical disks only — partitions and md/dm devices double-count bytes.
WHOLE_DISK_RE = re.compile(r"^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+)$")
CLK_TCK = os.sysconf("SC_CLK_TCK")
PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")


def sample_cpu():
    with open("/proc/stat") as f:
        parts = [int(x) for x in f.readline().split()[1:]]
    idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
    return sum(parts) - idle, sum(parts)


def sample_ram():
    info = {}
    with open("/proc/meminfo") as f:
        for line in f:
            key, _, rest = line.partition(":")
            info[key] = int(rest.split()[0]) * 1024
    return info["MemTotal"] - info["MemAvailable"], info["MemTotal"]


def sample_io():
    read = write = 0
    with open("/proc/diskstats") as f:
        for line in f:
            p = line.split()
            if len(p) >= 10 and WHOLE_DISK_RE.match(p[2]):
                read += int(p[5])
                write += int(p[9])
    return read, write, time.time()


def sample_disks(mounts):
    disks = []
    for path in mounts:
        try:
            s = os.statvfs(path)
        except OSError:
            continue                      # mount unavailable — omit this sample
        disks.append({
            "path": path,
            "usedBytes": (s.f_blocks - s.f_bfree) * s.f_frsize,
            "totalBytes": s.f_blocks * s.f_frsize,
        })
    return disks


_names = {}


def uid_name(uid):
    if uid not in _names:
        try:
            _names[uid] = pwd.getpwuid(uid).pw_name
        except KeyError:
            _names[uid] = str(uid)
    return _names[uid]


def scan_users():
    ticks, rss = {}, {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            uid = os.stat("/proc/" + name).st_uid
            with open("/proc/%s/stat" % name) as f:
                stat = f.read()
            rest = stat[stat.rindex(")") + 2:].split()
            t = int(rest[11]) + int(rest[12])            # utime + stime
            with open("/proc/%s/statm" % name) as f:
                pages = int(f.read().split()[1])
        except (OSError, ValueError, IndexError):
            continue                                       # exited mid-scan
        ticks[uid] = ticks.get(uid, 0) + t
        rss[uid] = rss.get(uid, 0) + pages * PAGE_SIZE
    return ticks, rss, time.time()


def diff_users(prev, cur):
    elapsed = cur[2] - prev[2]
    cpu = []
    if elapsed > 0:
        for uid, t in cur[0].items():
            delta = t - prev[0].get(uid, 0)
            if delta > 0:
                cpu.append({"name": uid_name(uid), "pct": 100.0 * delta / (CLK_TCK * elapsed)})
    cpu.sort(key=lambda u: -u["pct"])
    ram = sorted(({"name": uid_name(u), "bytes": b} for u, b in cur[1].items()),
                 key=lambda u: -u["bytes"])
    return {"cpu": cpu[:TOP_USERS], "ram": ram[:TOP_USERS]}


def write_atomic(path, payload):
    tmp = "%s.%s.tmp" % (path, os.getpid())
    with open(tmp, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", required=True, help="JSON file to replace each interval")
    ap.add_argument("--mount", action="append", default=[], help="mount to report (repeatable)")
    ap.add_argument("--interval", type=float, default=2.0, help="seconds between samples")
    args = ap.parse_args()
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)

    prev_cpu, prev_io = sample_cpu(), sample_io()
    prev_users, users = scan_users(), {"cpu": [], "ram": []}
    disks, disks_at, tick = [], 0.0, 0
    host = socket.gethostname()
    while True:
        time.sleep(args.interval)
        try:
            cpu, io = sample_cpu(), sample_io()
            ram_used, ram_total = sample_ram()
            cpu_pct = 0.0
            if cpu[1] > prev_cpu[1]:
                cpu_pct = 100.0 * (cpu[0] - prev_cpu[0]) / (cpu[1] - prev_cpu[1])
            dt = io[2] - prev_io[2]
            io_read = max(0, (io[0] - prev_io[0]) * 512) / dt if dt > 0 else 0
            io_write = max(0, (io[1] - prev_io[1]) * 512) / dt if dt > 0 else 0
            prev_cpu, prev_io = cpu, io
            if time.time() - disks_at > DISK_REFRESH_SEC:
                disks, disks_at = sample_disks(args.mount), time.time()
            tick += 1
            if tick % USER_SAMPLE_EVERY_TICKS == 0:
                scan = scan_users()
                users, prev_users = diff_users(prev_users, scan), scan
            write_atomic(args.out, {
                "schema": SCHEMA,
                "host": host,
                "generatedAt": int(time.time() * 1000),
                "intervalSec": args.interval,
                "stats": {
                    "cpuPercent": min(100.0, max(0.0, cpu_pct)),
                    "ramUsedBytes": ram_used,
                    "ramTotalBytes": ram_total,
                    "ioReadBytesPerSec": io_read,
                    "ioWriteBytesPerSec": io_write,
                    "disks": disks,
                    "users": users,
                },
            })
        except Exception as e:          # keep sampling; one bad tick must not end the feed
            print("[remote-system-stats] %s: %s" % (type(e).__name__, e), flush=True)


if __name__ == "__main__":
    main()
