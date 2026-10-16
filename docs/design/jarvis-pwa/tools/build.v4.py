#!/usr/bin/env python3
"""Build mock/index.html: inline subset IBM Plex fonts (stand ins per docs/DESIGN.md §Loading) so the mock is self contained."""
import base64, subprocess, tempfile, os, pathlib
here = pathlib.Path(__file__).resolve().parent
G = "/usr/share/fonts/truetype/sand-box/google"
fonts = [("Plex Sans", f"{G}/IBM Plex Sans/IBMPlexSans-VariableFont_wdth,wght.ttf", "400 700"),
         ("Plex Mono", f"{G}/IBM Plex Mono/IBMPlexMono-Regular.ttf", "400"),
         ("Plex Mono", f"{G}/IBM Plex Mono/IBMPlexMono-Medium.ttf", "500 600"),
         ("Plex Cond", f"{G}/IBM Plex Sans Condensed/IBMPlexSansCondensed-Bold.ttf", "700")]
css = []
for fam, path, w in fonts:
    with tempfile.NamedTemporaryFile(suffix=".woff", delete=False) as t: out = t.name
    subprocess.run(["pyftsubset", path, "--unicodes=U+0020-007E,U+00A0-00FF,U+00B7,U+00D7,U+2022,U+2026,U+2190-2193",
                    "--flavor=woff", f"--output-file={out}", "--layout-features=*"], check=True)
    b = base64.b64encode(open(out, "rb").read()).decode(); os.unlink(out)
    css.append(f'@font-face{{font-family:"{fam}";src:url(data:font/woff;base64,{b}) format("woff");font-weight:{w};font-display:block}}')
src = (here / "index.v4.src.html").read_text()
dst = here.parent / "mock" / "v4.html"
dst.write_text(src.replace("/*FONTS*/", "\n".join(css)))
print(dst, dst.stat().st_size, "bytes")
