"""Gera a pasta dist/ pronta a arrastar para o Netlify.
- Escapa caracteres não-ASCII do JavaScript inline como \\uXXXX (evita SyntaxError em alojamentos com charset errado)
- Gera os ícones e o manifesto
"""
import json, os, re, sys
from PIL import Image, ImageDraw, ImageFont

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BASE, 'src', 'index.src.html')
DIST = os.path.join(BASE, 'dist')
os.makedirs(DIST, exist_ok=True)

html = open(SRC, encoding='utf-8').read()

def esc(m):
    out = []
    for ch in m.group(0):
        cp = ord(ch)
        if cp < 128:
            out.append(ch)
        elif cp <= 0xFFFF:
            out.append('\\u%04x' % cp)
        else:
            cp -= 0x10000
            out.append('\\u%04x\\u%04x' % (0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)))
    return ''.join(out)

# só o script inline (sem src)
pat = re.compile(r'(<script>)(.*?)(</script>)', re.S)
n = 0
def repl(m):
    global n
    n += 1
    return m.group(1) + re.sub(r'[^\x00-\x7f]+', esc, m.group(2)) + m.group(3)
html = pat.sub(repl, html)
assert n == 1, n
open(os.path.join(DIST, 'index.html'), 'w', encoding='utf-8').write(html)

# Ícones
def icone(size):
    img = Image.new('RGB', (size, size), '#0a6cff')
    d = ImageDraw.Draw(img)
    s = size / 180
    # três barras a subir
    bw, gap, base = 26 * s, 12 * s, 128 * s
    x0 = (size - (3 * bw + 2 * gap)) / 2
    for i, hgt in enumerate([34, 58, 84]):
        x = x0 + i * (bw + gap)
        d.rounded_rectangle([x, base - hgt * s, x + bw, base], radius=7 * s, fill='white')
    f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', int(24 * s))
    t = 'GPP'
    w = d.textlength(t, font=f)
    d.text(((size - w) / 2, 140 * s), t, font=f, fill='white')
    return img

icone(180).save(os.path.join(DIST, 'apple-touch-icon.png'))
icone(512).save(os.path.join(DIST, 'icon-512.png'))
icone(192).save(os.path.join(DIST, 'icon-192.png'))

json.dump({
    'name': 'GPP Dashboard', 'short_name': 'GPP', 'lang': 'pt-PT',
    'start_url': './', 'scope': './', 'display': 'standalone',
    'background_color': '#f2f2f7', 'theme_color': '#f2f2f7',
    'icons': [
        {'src': 'icon-192.png', 'sizes': '192x192', 'type': 'image/png'},
        {'src': 'icon-512.png', 'sizes': '512x512', 'type': 'image/png'},
        {'src': 'apple-touch-icon.png', 'sizes': '180x180', 'type': 'image/png'}
    ]
}, open(os.path.join(DIST, 'manifest.webmanifest'), 'w'), ensure_ascii=False, indent=2)

# index.html não fica em cache: cada nova versão aparece logo no iPhone
open(os.path.join(DIST, '_headers'), 'w').write('/index.html\n  Cache-Control: no-cache\n/\n  Cache-Control: no-cache\n')
print('ok', os.listdir(DIST))
