"""Builds the small text-box fonts in src/fonts from the full Noto TTFs.

pdf-lib's own subsetting (embedFont(..., { subset: true })) drops glyph outlines
from Noto fonts, so we ship fonts that are already cut down to Latin + Turkish
and embed them whole. Run once after changing the character set:

    python -m venv .venv
    .venv/Scripts/pip install fonttools      # (.venv/bin/pip on macOS/Linux)
    .venv/Scripts/python scripts/subset-fonts.py
"""
from fontTools import subset

UNICODES = (
    "U+0020-007E,"   # Basic Latin
    "U+00A0-024F,"   # Latin-1 Supplement, Latin Extended-A/B (ç ğ ı İ ö ş ü ...)
    "U+02C6-02DD,"   # spacing accents
    "U+2010-2027,"   # dashes, quotes, bullet, ellipsis
    "U+2030-203A,"   # per mille, guillemets
    "U+20AC,U+20BA," # euro, Turkish lira
    "U+2116,U+2122"  # numero, trademark
)

FONTS = {
    "NotoSans-Regular.ttf": "noto-sans/400Regular/NotoSans_400Regular.ttf",
    "NotoSans-Bold.ttf": "noto-sans/700Bold/NotoSans_700Bold.ttf",
    "NotoSerif-Regular.ttf": "noto-serif/400Regular/NotoSerif_400Regular.ttf",
    "NotoSerif-Bold.ttf": "noto-serif/700Bold/NotoSerif_700Bold.ttf",
}

for out, src in FONTS.items():
    subset.main([
        f"node_modules/@expo-google-fonts/{src}",
        f"--unicodes={UNICODES}",
        "--layout-features=kern",
        "--name-IDs=*",
        "--notdef-outline",
        f"--output-file=src/fonts/{out}",
    ])
    print("wrote", out)
