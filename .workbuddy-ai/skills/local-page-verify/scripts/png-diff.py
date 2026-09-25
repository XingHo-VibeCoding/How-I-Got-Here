"""PNG 逐像素差分 / 裁切对比图 —— 手写 PNG 编解码，不依赖 Pillow。

为什么需要它：验证 hover、动画这类「只在某个状态存在」的效果时，
同会话拍的两张截图往往肉眼看不出差别（整行元素都在小幅位移，
缩略图上是分辨不出来的），但逐像素差分能给出确凿的结论。

用法：
    # 差分：报告两张图在指定行区间内，哪些「列」发生了变化
    python png-diff.py diff A.png B.png 285 380

    # 裁切：把指定区域裁剪 + 整数倍放大 + 上下拼接成一张对比图
    python png-diff.py crop A.png B.png 130 285 900 380 2 out.png

只支持 8 位深的 RGB / RGBA PNG（Chrome 的 Page.captureScreenshot 就是这个格式）。
"""
import sys
import zlib
import struct


def decode(path, max_rows=None):
    """解出前 max_rows 行。返回 (宽, 高, 通道数, [每行的 bytes])。

    滤波器必须顺序解码（后面的行引用前面的行），所以只能从第 0 行往下解，
    不能只解中间那几行——但可以提前停，省时间。
    """
    data = open(path, 'rb').read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('不是 PNG：' + path)

    pos, idat = 8, b''
    w = h = bd = ct = None
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if tag == b'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', body[:10])
        elif tag == b'IDAT':
            idat += body
        elif tag == b'IEND':
            break
        pos += 12 + ln

    if bd != 8:
        raise ValueError('只支持 8 位深，实际 %s 位' % bd)
    ch = {0: 1, 2: 3, 4: 2, 6: 4}.get(ct)
    if ch is None:
        raise ValueError('不支持的色彩类型 %s' % ct)

    stride = w * ch
    raw = zlib.decompress(idat)
    rows, prev, p = [], bytearray(stride), 0

    for _ in range(min(h, max_rows or h)):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride

        if f == 1:          # Sub
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 255
        elif f == 2:        # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:        # Average
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:        # Paeth
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255

        rows.append(bytes(line))
        prev = line

    return w, h, ch, rows


def encode(path, w, ch, rows):
    """写 8 位 RGB/RGBA PNG，滤波器统一用 0（不过滤），够用且简单。"""
    ct = {3: 2, 4: 6}[ch]
    raw = bytearray()
    for r in rows:
        raw.append(0)
        raw += r

    def chunk(tag, body):
        return (struct.pack('>I', len(body)) + tag + body
                + struct.pack('>I', zlib.crc32(tag + body) & 0xffffffff))

    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', w, len(rows), 8, ct, 0, 0, 0))
    out += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    out += chunk(b'IEND', b'')
    open(path, 'wb').write(out)


def cmd_diff(a, b, y0, y1, thresh):
    wa, ha, ca, ra = decode(a, y1)
    wb, hb, cb, rb = decode(b, y1)
    if (wa, ca) != (wb, cb):
        raise ValueError('两张图尺寸/通道不一致：%s vs %s' % ((wa, ca), (wb, cb)))

    hits = {}
    for y in range(y0, min(y1, len(ra), len(rb))):
        la, lb = ra[y], rb[y]
        for x in range(wa):
            i = x * ca
            d = abs(la[i] - lb[i]) + abs(la[i + 1] - lb[i + 1]) + abs(la[i + 2] - lb[i + 2])
            if d > thresh:
                hits[x] = hits.get(x, 0) + 1

    print('图宽 %d，扫描行 %d..%d，颜色阈值 %d' % (wa, y0, y1, thresh))
    if not hits:
        print('两图在该区域完全一致 —— 说明被测变量没有产生任何渲染变化')
        return 1

    xs = sorted(hits)
    runs, s, prev = [], xs[0], xs[0]
    for x in xs[1:]:
        if x - prev > 2:
            runs.append((s, prev))
            s = x
        prev = x
    runs.append((s, prev))

    print('发生差异的列数：%d，分成 %d 段：' % (len(hits), len(runs)))
    for a_, b_ in runs:
        print('   x %4d .. %4d   （宽 %d px）' % (a_, b_, b_ - a_ + 1))
    print('\n读法：每段对应一个「位置变了」的元素；段数 = 动了几个元素。')
    return 0


def cmd_crop(a, b, x0, y0, x1, y1, z, out):
    wa, ha, ca, ra = decode(a, y1)
    wb, hb, cb, rb = decode(b, y1)
    if ca != cb or ca not in (3, 4):
        raise ValueError('裁切模式需要两张同通道的 RGB/RGBA 图')

    def zoom(rows):
        acc = []
        for y in range(y0, y1):
            src = rows[y]
            line = bytearray()
            for x in range(x0, x1):
                line += src[x * ca:(x + 1) * ca] * z
            for _ in range(z):
                acc.append(bytes(line))
        return acc

    w = (x1 - x0) * z
    gap = [bytes([120, 120, 120]) * w for _ in range(3 * z)]
    top, bot = zoom(ra), zoom(rb)
    rows = top + gap + bot
    encode(out, w, ca, rows)
    print('已生成 %s （%d x %d，上=图 A，下=图 B）' % (out, w, len(rows)))


if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'diff':
        sys.exit(cmd_diff(sys.argv[2], sys.argv[3],
                          int(sys.argv[4]), int(sys.argv[5]),
                          int(sys.argv[6]) if len(sys.argv) > 6 else 8))
    elif mode == 'crop':
        cmd_crop(sys.argv[2], sys.argv[3],
                 int(sys.argv[4]), int(sys.argv[5]),
                 int(sys.argv[6]), int(sys.argv[7]),
                 int(sys.argv[8]), sys.argv[9])
    else:
        print(__doc__)
        sys.exit(2)
