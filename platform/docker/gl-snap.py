#!/usr/bin/env python3
"""Dump the current DOSBox-X Game Link frame to a PNG.

Layout follows src/gamelink/gamelink.h (packed, little-endian):
  sSharedMemoryMap_R4: version u8, flags u8, system[64], program[260],
  program_hash u32[4], then sSharedMMapFrame_R1: seq u16, width u16,
  height u16, image_fmt u8, reserved u8, par_x u16, par_y u16, buffer[].
Pixels are 32-bit 0xAARRGGBB, i.e. bytes B,G,R,A in memory.

usage: gl-snap [out.png]      (default /data/capture/frame.png)
"""
import struct
import sys
import zlib

SHM = "/dev/shm/DWD_GAMELINK_MMAP_R4"
HDR = 1 + 1 + 64 + 260 + 16
FRAME_HDR = struct.Struct("<HHHBBHH")


def read_frame():
    with open(SHM, "rb") as f:
        head = f.read(HDR + FRAME_HDR.size)
        version, flags = head[0], head[1]
        program = head[66:326].split(b"\0", 1)[0].decode("latin-1")
        seq, w, h, fmt, _, par_x, par_y = FRAME_HDR.unpack_from(head, HDR)
        if fmt != 1 or not w or not h:
            raise SystemExit(f"no frame yet (fmt={fmt} {w}x{h} seq={seq})")
        pixels = f.read(w * h * 4)
    return dict(version=version, flags=flags, program=program, seq=seq,
                w=w, h=h, par=(par_x, par_y), pixels=pixels)


def png(w, h, bgra):
    rows = bytearray()
    for y in range(h):
        row = bgra[y * w * 4:(y + 1) * w * 4]
        rgb = bytearray(w * 3)
        rgb[0::3] = row[2::4]
        rgb[1::3] = row[1::4]
        rgb[2::3] = row[0::4]
        rows += b"\0" + rgb

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 6))
            + chunk(b"IEND", b""))


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "/data/capture/frame.png"
    fr = read_frame()
    with open(out, "wb") as f:
        f.write(png(fr["w"], fr["h"], fr["pixels"]))
    print(f"seq={fr['seq']} {fr['w']}x{fr['h']} par={fr['par']} "
          f"flags={fr['flags']:#x} program={fr['program']!r} -> {out}")


if __name__ == "__main__":
    main()
