#!/usr/bin/env python3
"""生成扫码入口的 PNG 资源。

产出两个文件（都写进 docs/，README 直接引用）：
  qrcode.png       纯二维码，白底黑码 —— 微信/相册长按识别率最高
  qrcode-card.png  带标题与一句话的转发卡片 —— 直接发微信聊天最方便

依赖：pip install segno pillow zxing-cpp
用法：python3 scripts/make-qr.py [--url https://...]
"""
import argparse
import os
import sys

import segno
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(os.path.dirname(HERE), 'docs')

DEFAULT_URL = 'https://leoli236.github.io/mcd-midnight-snack/'

BRAND_DARK = (28, 25, 54)      # #1c1936  夜色底
BRAND_WARM = (246, 211, 101)   # #f6d365  暖黄
INK = '#12101f'                # 码点用近黑，不用纯黑，扫起来一样稳、看着更柔


def pick_font(size):
    """挑一个真的带汉字字形的 face。ttc 里有些 index 是拉丁专用，
    getbbox 拿到的宽度会明显偏小，据此筛掉。"""
    cands = [
        '/System/Library/Fonts/PingFang.ttc',
        '/System/Library/Fonts/Hiragino Sans GB.ttc',
        '/System/Library/Fonts/STHeiti Medium.ttc',
        '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
        'C:/Windows/Fonts/msyh.ttc',
    ]
    for path in cands:
        if not os.path.exists(path):
            continue
        for idx in range(0, 10):
            try:
                f = ImageFont.truetype(path, size, index=idx)
            except Exception:
                break
            bbox = f.getbbox('深')
            if bbox and (bbox[2] - bbox[0]) > size * 0.5:
                return f
    print('警告：没找到中文字体，标题会变豆腐块', file=sys.stderr)
    return ImageFont.load_default()


def build_plain(url):
    q = segno.make(url, error='h')
    out = os.path.join(DOCS, 'qrcode.png')
    q.save(out, scale=12, border=3, dark=INK, light='#ffffff')
    return out


def build_card(url):
    W, H = 900, 1200
    card = Image.new('RGB', (W, H), BRAND_DARK)
    d = ImageDraw.Draw(card)
    d.rectangle([0, 0, W, 8], fill=BRAND_WARM)

    f_title = pick_font(64)
    f_sub = pick_font(30)
    f_body = pick_font(26)
    f_link = pick_font(24)

    def center(text, y, font, fill):
        bbox = d.textbbox((0, 0), text, font=font)
        d.text(((W - (bbox[2] - bbox[0])) / 2, y), text, font=font, fill=fill)

    center('深夜进食', 96, f_title, BRAND_WARM)
    center('Midnight Snack', 178, f_sub, (200, 190, 230))
    center('加了一天班，想吃，又怕胖。', 250, f_body, (235, 232, 245))
    center('麦当劳真实菜单 · 单文件网页小游戏', 292, f_body, (170, 164, 200))

    # 码体：白底 + 近黑码点，四周留静区，描一圈暖黄边
    qsize = 420
    tmp = os.path.join(DOCS, '_q_tmp.png')
    segno.make(url, error='h').save(tmp, scale=10, border=2,
                                    dark=INK, light='#ffffff')
    qimg = Image.open(tmp).resize((qsize, qsize), Image.NEAREST)
    os.remove(tmp)

    pad = 26
    qx, qy = (W - qsize) // 2, 360
    card.paste(qimg, (qx, qy))
    d.rectangle([qx - pad, qy - pad, qx + qsize + pad, qy + qsize + pad],
                outline=BRAND_WARM, width=3)

    center('长按识别 · 扫码直接玩', 840, f_body, BRAND_WARM)
    center('不用下载，不用装环境，微信里也能开', 884, f_body, (170, 164, 200))

    lb = d.textbbox((0, 0), url, font=f_link)
    lx = (W - (lb[2] - lb[0])) // 2
    d.text((lx, 1050), url, font=f_link, fill=(200, 190, 230))
    d.line([lx, 1084, lx + lb[2] - lb[0], 1084], fill=(120, 112, 160), width=2)

    out = os.path.join(DOCS, 'qrcode-card.png')
    card.save(out)
    return out


def verify(path, url):
    """必须回扫验证 —— 二维码错了放 README 里很尴尬。"""
    try:
        import zxingcpp
    except ImportError:
        print(f'  {os.path.basename(path)}: 跳过解码验证（未装 zxing-cpp）')
        return None
    got = zxingcpp.read_barcode(Image.open(path))
    ok = got is not None and got.text == url
    print(f'  {os.path.basename(path)}: {got.text if got else "未识别"} '
          f'{"✓" if ok else "✗"}')
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default=DEFAULT_URL)
    args = ap.parse_args()

    os.makedirs(DOCS, exist_ok=True)
    print('生成：')
    for out in (build_plain(args.url), build_card(args.url)):
        with Image.open(out) as im:
            kb = os.path.getsize(out) / 1024
            print(f'  {os.path.basename(out)}  {im.size[0]}×{im.size[1]}  {kb:.0f} KB')
    print('回扫验证：')
    ok = verify(os.path.join(DOCS, 'qrcode.png'), args.url)
    ok2 = verify(os.path.join(DOCS, 'qrcode-card.png'), args.url)
    if ok is False or ok2 is False:
        sys.exit('二维码内容与 URL 不一致，拒绝生成')


if __name__ == '__main__':
    main()
