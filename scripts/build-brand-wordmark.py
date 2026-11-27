import argparse
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont


def outline_line(font_path, text, font_size, weight, top, color):
    with TTFont(font_path) as font:
        glyphs = font.getGlyphSet(location={"wght": weight})
        character_map = font.getBestCmap()
        scale = font_size / font["head"].unitsPerEm
        measurements = []
        cursor = 0
        for character in text:
            glyph = glyphs[character_map[ord(character)]]
            bounds_pen = BoundsPen(glyphs)
            glyph.draw(bounds_pen)
            measurements.append((glyph, cursor, bounds_pen.bounds))
            cursor += glyph.width * scale

        left = measurements[0][2][0] * scale
        right = measurements[-1][1] + measurements[-1][2][2] * scale
        tracking = (90 - (right - left)) / (len(text) - 1)
        baseline = top + max(bounds[3] for _, _, bounds in measurements) * scale
        paths = []
        for index, (glyph, position, _) in enumerate(measurements):
            path_pen = SVGPathPen(glyphs, ntos=lambda value: f"{value:.3f}".rstrip("0").rstrip("."))
            glyph.draw(TransformPen(path_pen, (scale, 0, 0, -scale, 3 - left + position + tracking * index, baseline)))
            paths.append(f'<path d="{path_pen.getCommands()}"/>')
        return f'<g fill="{color}">{"".join(paths)}</g>'


def build_wordmark(chinese_font, english_font):
    chinese = outline_line(chinese_font, "共智体", 26, 500, 2, "#f3f0e7")
    english = outline_line(english_font, "RESONA", 10, 450, 37, "#c3b48b")
    divider = '<path d="M3 32.5H93" fill="none" stroke="#dfcd98" stroke-width="1.2" stroke-linecap="round"/>'
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 48" width="96" height="48">'
        '<title>共智体 RESONA</title>'
        f'{chinese}{divider}{english}</svg>\n'
    )
    output = Path(__file__).resolve().parents[1] / "public" / "brand" / "resona-wordmark.svg"
    output.write_text(svg, encoding="utf-8")
    print(f"Wordmark: {output} ({output.stat().st_size} bytes)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--chinese-font", required=True)
    parser.add_argument("--english-font", required=True)
    arguments = parser.parse_args()
    build_wordmark(arguments.chinese_font, arguments.english_font)
