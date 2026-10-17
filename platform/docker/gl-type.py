import os, struct, sys, time
# offsets from gamelink.h: header 342, frame 12 + 1280*1024*4, then sSharedMMapInput_R2
INPUT = 342 + 12 + 1280 * 1024 * 4
fd = os.open("/dev/shm/DWD_GAMELINK_MMAP_R4", os.O_RDWR)
SC = {c: s for c, s in zip("1234567890", range(0x02, 0x0C))}
SC.update(dict(zip("qwertyuiop", range(0x10, 0x1A))))
SC.update(dict(zip("asdfghjkl", range(0x1E, 0x27))))
SC.update(dict(zip("zxcvbnm", range(0x2C, 0x33))))
SC.update({" ": 0x39, "|": 0x1C, ".": 0x34})   # "|" = Enter
SHIFT = 0x2A


def send(bits):
    words = [0] * 8
    for b in bits:
        words[b // 32] |= 1 << (b % 32)
    os.pwrite(fd, struct.pack("<8I", *words), INPUT + 10)
    os.pwrite(fd, b"\x01", INPUT + 8)          # ready
    t = time.time()
    while os.pread(fd, 1, INPUT + 8) == b"\x01" and time.time() - t < 1:
        time.sleep(0.005)                       # wait until DOSBox consumed it
    time.sleep(0.03)


for ch in sys.argv[1]:
    if ch == ">":
        send([SHIFT]); send([SHIFT, 0x34]); send([SHIFT]); send([])
        continue
    send([SC[ch.lower()]]); send([])
print("typed", repr(sys.argv[1]))
