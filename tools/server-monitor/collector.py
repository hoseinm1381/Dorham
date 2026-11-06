"""Read-only, one-shot Linux sample. Sent through SSH; never installed remotely."""
import json
import os
import pathlib
import socket
import subprocess
import time

proc = pathlib.Path('/proc')
mem = {}
for line in (proc / 'meminfo').read_text().splitlines():
    key, value = line.split(':', 1)
    mem[key] = int(value.strip().split()[0]) * 1024
cpu = list(map(int, (proc / 'stat').read_text().splitlines()[0].split()[1:9]))
disk = os.statvfs('/')
interface = None
for line in (proc / 'net/route').read_text().splitlines()[1:]:
    fields = line.split()
    if fields[1] == '00000000' and int(fields[3], 16) & 1:
        interface = fields[0]
        break
network = None
for line in (proc / 'net/dev').read_text().splitlines()[2:]:
    name, values = line.split(':', 1)
    if name.strip() == interface:
        fields = values.split()
        network = {'interface': interface, 'rx': int(fields[0]), 'tx': int(fields[8])}
        break
services = []
try:
    output = subprocess.run(
        ['systemctl', 'show', 'dorham', 'livekit', 'caddy', 'haproxy',
         '--property=Id,ActiveState,MemoryCurrent,CPUUsageNSec'],
        capture_output=True, text=True, timeout=3, check=False)
    for block in output.stdout.strip().split('\n\n'):
        props = dict(line.split('=', 1) for line in block.splitlines() if '=' in line)
        if 'Id' in props:
            def number(key):
                value = props.get(key, '')
                return int(value) if value.isdecimal() and int(value) < 2**63 else None
            services.append({'name': props['Id'].removesuffix('.service'),
                             'state': props.get('ActiveState', 'unknown'),
                             'memory': number('MemoryCurrent'), 'cpuNs': number('CPUUsageNSec')})
except (OSError, subprocess.TimeoutExpired):
    pass
traffic = None
try:
    traffic = json.loads(pathlib.Path('/var/lib/dorham-ops/traffic.json').read_text())
except (OSError, ValueError):
    pass
print(json.dumps({
    'time': time.monotonic(), 'bootId': (proc / 'sys/kernel/random/boot_id').read_text().strip(),
    'host': socket.gethostname(), 'cores': os.cpu_count(),
    'uptime': float((proc / 'uptime').read_text().split()[0]),
    'cpuTotal': sum(cpu), 'cpuIdle': cpu[3] + cpu[4], 'load': os.getloadavg()[0],
    'memoryTotal': mem['MemTotal'], 'memoryAvailable': mem['MemAvailable'],
    'swapTotal': mem.get('SwapTotal', 0), 'swapFree': mem.get('SwapFree', 0),
    'diskTotal': disk.f_blocks * disk.f_frsize,
    'diskUsed': (disk.f_blocks - disk.f_bfree) * disk.f_frsize,
    'diskAvailable': disk.f_bavail * disk.f_frsize,
    'network': network, 'services': services, 'traffic': traffic
}, separators=(',', ':')))
