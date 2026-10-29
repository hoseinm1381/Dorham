#!/usr/bin/env python3
"""Estimated incoming quota from persistent vnStat counters; provider billing wins."""
import datetime
import json
import pathlib
import subprocess
import sys


def report(config, counters, now):
    incoming = max(0, counters['traffic']['total']['rx'] - config.get('baselineRx', 0))
    used = incoming + config.get('reserveBytes', 0)
    budget = config['quotaBytes']
    ratio = used / budget
    start = datetime.datetime.fromisoformat(config['periodStart'])
    elapsed = max(1, (now - start).total_seconds() / 86400)
    projection = used * config['periodDays'] / elapsed
    return {'measuredAt': now.isoformat(), 'interface': counters['name'],
            'incomingMeasuredBytes': incoming, 'accountingReserveBytes': config.get('reserveBytes', 0),
            'quotaBytes': budget, 'estimatedRemainingBytes': max(0, budget - used),
            'usedPercent': round(ratio * 100, 2), 'projectedPeriodBytes': round(projection),
            'level': 'critical' if ratio >= .9 else 'warning' if ratio >= .8 else 'normal',
            'note': 'Estimate since pilot start, including a setup reserve. Provider dashboard is authoritative; no automatic top-up or service shutdown.'}


def main():
    config_path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/etc/dorham/traffic.json')
    config = json.loads(config_path.read_text())
    result = json.loads(subprocess.check_output(['vnstat', '--json', '-i', config['interface']], text=True))
    value = report(config, result['interfaces'][0], datetime.datetime.now(datetime.timezone.utc))
    output = pathlib.Path(config['output'])
    previous = json.loads(output.read_text()) if output.exists() else {}
    temporary = output.with_suffix('.new')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(output)
    if value['level'] != previous.get('level'):
        print('TRAFFIC_' + value['level'].upper(), json.dumps(value))


if __name__ == '__main__':
    main()
