"""대한항공 공식 2D 패턴 AI(PDF 호환) → SVG.

도형 경로를 좌표 그대로 옮기고 지정 색 하나로 칠한다(패턴 AI 는 색 없는 단색 도형).
사용: python3 tools/ai_to_svg.py <KE_primary-2D-pattern_expand.ai> <out.svg> [#HEX]
"""
import sys

import pypdf
from pypdf.generic import ContentStream

FILL_OPS = {'f', 'F', 'f*', 'B', 'B*', 'b', 'b*'}
EVENODD_OPS = {'f*', 'B*', 'b*'}
# 그림을 그리지만 이 도구가 옮기지 않는 연산자 — 만나면 보고한다(부분 누락을 알아채도록)
PAINT_UNHANDLED = {'Do', 'sh', 'BI', 'INLINE IMAGE', 'Tj', 'TJ', "'", '"'}
DISCARD_OPS = {'n', 'S', 's'}          # 클리핑·외곽선 경로는 버린다(패턴은 채움 도형뿐)
NUMERIC_OPS = {'cm', 'm', 'l', 'c', 'v', 'y', 're'}


def _mul(a, b):
    """PDF 행렬 [a b c d e f] 곱: a 를 적용한 뒤 b."""
    return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
            a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
            a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]]


def convert(src, fill):
    """src: 파일 경로 또는 파일 객체. (svg 문자열, {'shapes', 'w', 'h', 'ignored'}) 반환."""
    reader = pypdf.PdfReader(src)
    page = reader.pages[0]
    x0, y0, x1, y1 = (float(v) for v in page.mediabox)
    w, h = x1 - x0, y1 - y0
    ctm, stack, cur, paths, ignored = [1, 0, 0, 1, 0, 0], [], [], [], []
    cp = start = (0.0, 0.0)   # 현재 점 · 부분 경로 시작점(사용자 좌표) — v 곡선의 첫 조절점
    contents = page.get_contents()
    ops = ContentStream(contents, reader).operations if contents is not None else []

    def pt(x, y):
        px = ctm[0] * x + ctm[2] * y + ctm[4] - x0
        py = ctm[1] * x + ctm[3] * y + ctm[5] - y0
        return f'{px:.2f} {h - py:.2f}'

    for operands, op in ops:
        op = op.decode() if isinstance(op, bytes) else str(op)
        n = [float(v) for v in operands] if op in NUMERIC_OPS else []
        if op == 'q':
            stack.append(ctm[:])
        elif op == 'Q':
            ctm = stack.pop()
        elif op == 'cm':
            ctm = _mul(n, ctm)
        elif op == 'm':
            cur.append('M' + pt(n[0], n[1]))
            cp = start = (n[0], n[1])
        elif op == 'l':
            cur.append('L' + pt(n[0], n[1]))
            cp = (n[0], n[1])
        elif op == 'c':
            cur.append('C' + pt(n[0], n[1]) + ' ' + pt(n[2], n[3]) + ' ' + pt(n[4], n[5]))
            cp = (n[4], n[5])
        elif op == 'v':          # 첫 조절점 = 현재 점
            cur.append('C' + pt(*cp) + ' ' + pt(n[0], n[1]) + ' ' + pt(n[2], n[3]))
            cp = (n[2], n[3])
        elif op == 'y':          # 둘째 조절점 = 끝점
            cur.append('C' + pt(n[0], n[1]) + ' ' + pt(n[2], n[3]) + ' ' + pt(n[2], n[3]))
            cp = (n[2], n[3])
        elif op == 're':
            x, y, rw, rh = n
            cur.append('M' + pt(x, y) + 'L' + pt(x + rw, y) + 'L' + pt(x + rw, y + rh) + 'L' + pt(x, y + rh) + 'Z')
            cp = start = (x, y)
        elif op == 'h':
            cur.append('Z')
            cp = start
        elif op in FILL_OPS:
            # 채움마다 따로(겹친 도형이 nonzero 규칙으로 서로 지워지지 않게), 짝홀 규칙은 유지
            if cur:
                rule = ' fill-rule="evenodd"' if op in EVENODD_OPS else ''
                paths.append(f'<path{rule} d="{"".join(cur)}"/>')
            cur = []
        elif op in PAINT_UNHANDLED and op not in ignored:
            ignored.append(op)
        elif op in DISCARD_OPS:
            cur = []

    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.0f}" height="{h:.0f}" viewBox="0 0 {w:.2f} {h:.2f}">'
           f'<g fill="{fill}">{"".join(paths)}</g></svg>')
    return svg, {'shapes': len(paths), 'w': w, 'h': h, 'ignored': ignored}


if __name__ == '__main__':
    svg, stats = convert(sys.argv[1], sys.argv[3] if len(sys.argv) > 3 else '#DBE2E9')
    with open(sys.argv[2], 'w') as fh:
        fh.write(svg)
    print(f"size={stats['w']:.0f}x{stats['h']:.0f}pt shapes={stats['shapes']} bytes={len(svg)}")
    if stats['ignored']:
        print(f"경고: 옮기지 않은 그리기 연산자 {stats['ignored']} — 결과에서 빠진 부분이 있을 수 있음", file=sys.stderr)
