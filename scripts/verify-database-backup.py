"""Restore a Dorham SQLite backup into temporary storage and record the result."""

import argparse
from contextlib import closing
import datetime
import gzip
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backup", type=Path)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    source = args.backup.resolve(strict=True)
    if args.receipt and args.receipt.resolve() == source:
        parser.error("The receipt must use a separate path.")
    if not source.is_file():
        parser.error("Use a regular SQLite backup file.")

    with tempfile.TemporaryDirectory(prefix="dorham-restore-check-") as directory:
        restored = Path(directory) / "dorham.sqlite"
        opener = gzip.open if source.suffix == ".gz" else open
        with opener(source, "rb") as backup, restored.open("xb") as sample:
            shutil.copyfileobj(backup, sample)
        with closing(sqlite3.connect(restored.as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
            if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise SystemExit("SQLite integrity check failed.")
            for table in ("schema_migrations", "users", "messages"):
                db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()

    receipt = {"schema": 1, "verifiedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    if args.receipt:
        target = args.receipt.resolve()
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, delete=False) as output:
            temporary = Path(output.name)
            json.dump(receipt, output)
        try:
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
