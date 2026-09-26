"""tools/ai_to_svg.py — 대한항공 공식 패턴 AI(PDF 호환) → SVG 변환 검증.

작은 PDF 를 직접 만들어 좌표 뒤집기(PDF y-up → SVG y-down), 변환 행렬, 클리핑 경로 제외,
곡선을 확인한다. 실행: python3 -m unittest discover -s tests/tools
"""
import io
import os
import sys
import unittest

import pypdf
from pypdf.generic import DecodedStreamObject, NameObject

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'tools'))
from ai_to_svg import convert  # noqa: E402


def make_pdf(content: bytes, w=100, h=50) -> io.BytesIO:
    wr = pypdf.PdfWriter()
    page = wr.add_blank_page(width=w, height=h)
    stream = DecodedStreamObject()
    stream.set_data(content)
    page[NameObject('/Contents')] = wr._add_object(stream)
    buf = io.BytesIO()
    wr.write(buf)
    buf.seek(0)
    return buf


class ConvertTest(unittest.TestCase):
    def test_rectangle_flips_y(self):
        svg, stats = convert(make_pdf(b'10 5 20 10 re f'), '#DBE2E9')
        self.assertIn('viewBox="0 0 100.00 50.00"', svg)
        self.assertIn('fill="#DBE2E9"', svg)
        # y=5..15 (PDF) → SVG y = 50-5=45 .. 50-15=35
        self.assertIn('M10.00 45.00L30.00 45.00L30.00 35.00L10.00 35.00Z', svg)
        self.assertEqual(stats['shapes'], 1)

    def test_cm_translation_and_q_Q_stack(self):
        svg, _ = convert(make_pdf(b'q 1 0 0 1 10 20 cm 0 0 m 5 0 l 5 5 l h f Q 0 0 m 1 0 l 1 1 l h f'), '#000')
        self.assertIn('M10.00 30.00L15.00 30.00L15.00 25.00Z', svg)
        self.assertIn('M0.00 50.00L1.00 50.00L1.00 49.00Z', svg)   # Q 뒤에는 원래 좌표계

    def test_clip_path_is_dropped(self):
        svg, stats = convert(make_pdf(b'0 0 100 50 re W n 1 1 2 2 re f'), '#000')
        self.assertEqual(stats['shapes'], 1)
        self.assertNotIn('M0.00 50.00L100.00', svg)

    def test_bezier_curve(self):
        svg, _ = convert(make_pdf(b'0 0 m 10 0 10 10 0 10 c h f'), '#000')
        self.assertIn('C10.00 50.00 10.00 40.00 0.00 40.00', svg)

    def test_nested_cm_order_scale_then_translate(self):
        # 새 CTM = M × CTM: 2배 확대 안에서 10 이동 → 실제로는 20 이동
        svg, _ = convert(make_pdf(b'2 0 0 2 0 0 cm 1 0 0 1 10 0 cm 0 0 m 1 0 l 1 1 l h f'), '#000')
        self.assertIn('M20.00 50.00L22.00 50.00L22.00 48.00Z', svg)

    def test_rotation_is_not_transposed(self):
        # 90° 회전(0 1 -1 0): (1,0) → (0,1), (0,1) → (-1,0); 뒤이어 (50,10) 이동
        svg, _ = convert(make_pdf(b'1 0 0 1 50 10 cm 0 1 -1 0 0 0 cm 0 0 m 1 0 l 0 1 l h f'), '#000')
        self.assertIn('M50.00 40.00L50.00 39.00L49.00 40.00Z', svg)

    def test_mediabox_origin_offset(self):
        buf = make_pdf(b'10 20 5 5 re f')
        r = pypdf.PdfReader(buf)
        wr = pypdf.PdfWriter()
        page = wr.add_page(r.pages[0])
        page.mediabox = pypdf.generic.RectangleObject([10, 20, 110, 70])
        out = io.BytesIO()
        wr.write(out)
        out.seek(0)
        svg, _ = convert(out, '#000')
        self.assertIn('viewBox="0 0 100.00 50.00"', svg)
        self.assertIn('M0.00 50.00L5.00 50.00L5.00 45.00L0.00 45.00Z', svg)

    def test_each_fill_is_its_own_path_and_evenodd_kept(self):
        svg, stats = convert(make_pdf(b'0 0 10 10 re f 20 0 10 10 re f*'), '#000')
        self.assertEqual(stats['shapes'], 2)
        self.assertEqual(svg.count('<path '), 2)
        self.assertEqual(svg.count('fill-rule="evenodd"'), 1)

    def test_unhandled_painting_ops_are_reported(self):
        _, stats = convert(make_pdf(b'0 0 1 1 re f /Sh0 sh'), '#000')
        self.assertEqual(stats['ignored'], ['sh'])

    def test_current_point_after_re_and_close(self):
        # re 뒤 현재 점 = (x,y) → v 의 첫 조절점
        svg, _ = convert(make_pdf(b'2 3 4 4 re 9 9 9 9 v f'), '#000')
        self.assertIn('C2.00 47.00 9.00 41.00 9.00 41.00', svg)

    def test_empty_page(self):
        wr = pypdf.PdfWriter()
        wr.add_blank_page(width=10, height=10)
        buf = io.BytesIO()
        wr.write(buf)
        buf.seek(0)
        svg, stats = convert(buf, '#000')
        self.assertEqual(stats['shapes'], 0)
        self.assertIn('viewBox="0 0 10.00 10.00"', svg)

    def test_v_curve_uses_current_point_as_first_control(self):
        # v x2 y2 x3 y3 → 첫 조절점 = 현재 점(4,0)
        svg, _ = convert(make_pdf(b'4 0 m 8 2 8 6 v h f'), '#000')
        self.assertIn('M4.00 50.00C4.00 50.00 8.00 48.00 8.00 44.00', svg)

    def test_y_curve_uses_end_point_as_second_control(self):
        # y x1 y1 x3 y3 → 둘째 조절점 = 끝점(8,6)
        svg, _ = convert(make_pdf(b'4 0 m 8 2 8 6 y h f'), '#000')
        self.assertIn('C8.00 48.00 8.00 44.00 8.00 44.00', svg)

    def test_current_point_follows_transform(self):
        svg, _ = convert(make_pdf(b'q 1 0 0 1 10 0 cm 0 0 m 1 1 2 2 v h f Q'), '#000')
        self.assertIn('M10.00 50.00C10.00 50.00 11.00 49.00 12.00 48.00', svg)


if __name__ == '__main__':
    unittest.main()
