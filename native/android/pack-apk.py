#!/usr/bin/env python3
"""Add DEX files and align stored ZIP entries. No native libraries are packaged."""
import pathlib
import struct
import sys
import zipfile


def pack(base, dex_dir, output):
    with zipfile.ZipFile(base) as source, zipfile.ZipFile(output, "w") as target:
        for entry in source.infolist():
            info = zipfile.ZipInfo(entry.filename, date_time=(2025, 1, 1, 0, 0, 0))
            info.compress_type = entry.compress_type
            info.external_attr = entry.external_attr
            if info.compress_type == zipfile.ZIP_STORED:
                if target.fp is None:
                    raise RuntimeError("Output archive is closed")
                start = target.fp.tell() + 30 + len(info.filename.encode("utf-8"))
                padding = (-start) % 4
                if padding:
                    padding += 4
                    info.extra = struct.pack("<HH", 0xFFFF, padding - 4) + bytes(padding - 4)
            target.writestr(info, source.read(entry))
        for dex in sorted(pathlib.Path(dex_dir).glob("classes*.dex")):
            target.write(dex, dex.name, compress_type=zipfile.ZIP_DEFLATED)
    with open(output, "rb") as raw, zipfile.ZipFile(output) as archive:
        for entry in archive.infolist():
            if entry.compress_type != zipfile.ZIP_STORED:
                continue
            raw.seek(entry.header_offset + 26)
            name_size, extra_size = struct.unpack("<HH", raw.read(4))
            if (entry.header_offset + 30 + name_size + extra_size) % 4 != 0:
                raise ValueError(f"Unaligned APK entry: {entry.filename}")


if __name__ == "__main__":
    pack(*sys.argv[1:])
