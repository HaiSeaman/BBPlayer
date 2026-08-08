import os
import math
from PIL import Image, ImageDraw, ImageFilter

def create_app_icon(size=512):
    # 创建 RGBA 透明画布
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    
    # Glow / Lighting Canvas
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_glow = ImageDraw.Draw(glow)
    
    # 1. 绘制底层发光微光 Ambient Glow
    glow_color = (0, 242, 254, 45) # 冰蓝微光
    center = size // 2
    draw_glow.ellipse([center - 180, center - 180, center + 180, center + 180], fill=glow_color)
    glow = glow.filter(ImageFilter.GaussianBlur(40))
    
    img = Image.alpha_composite(img, glow)
    draw = ImageDraw.Draw(img)

    # 2. 绘制 Squircle (超椭圆圆角卡片) 底座
    # 基础卡片区域 [40, 40, 472, 472]
    padding = 48
    box = [padding, padding, size - padding, size - padding]
    radius = 100
    
    # 背景深黑暗夜渐变 + 微发光
    card = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    card_draw = ImageDraw.Draw(card)
    
    # 绘制超级圆角矩形
    card_draw.rounded_rectangle(box, radius=radius, fill=(14, 17, 24, 255))
    
    # 添加内部渐变质感 (模拟光影)
    overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ov_draw = ImageDraw.Draw(overlay)
    
    for y in range(box[1], box[3]):
        factor = (y - box[1]) / (box[3] - box[1])
        r = int(25 * (1 - factor*0.7))
        g = int(30 * (1 - factor*0.7))
        b = int(45 * (1 - factor*0.5))
        ov_draw.line([(box[0], y), (box[2], y)], fill=(r, g, b, 230))
        
    # 用 mask 裁剪为圆角矩形
    mask = Image.new("L", (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle(box, radius=radius, fill=255)
    
    card.paste(overlay, (0, 0), mask)
    
    # 给卡片加 1.5px 极细深钛银外描边
    card_draw = ImageDraw.Draw(card)
    card_draw.rounded_rectangle(box, radius=radius, outline=(255, 255, 255, 38), width=3)
    
    img = Image.alpha_composite(img, card)
    draw = ImageDraw.Draw(img)

    # 3. 绘制性感核心：流线型双弧 B 字母切面 + 霓虹 Play 三角
    # A) 弧形折影背景线
    b_path_color = (255, 255, 255, 20)
    draw.arc([160, 140, 360, 370], start=270, end=90, fill=b_path_color, width=4)
    
    # B) 核心高亮发光 Play 按钮 (圆角三角形)
    triangle_card = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tri_draw = ImageDraw.Draw(triangle_card)
    
    # 三角形顶点坐标
    # Center slightly offset to look visually centered
    p1 = (195, 150)
    p2 = (365, 256)
    p3 = (195, 362)
    
    # 绘制霓虹渐变三角形
    tri_glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tri_glow_draw = ImageDraw.Draw(tri_glow)
    tri_glow_draw.polygon([p1, p2, p3], fill=(0, 242, 254, 180))
    tri_glow = tri_glow.filter(ImageFilter.GaussianBlur(25))
    
    img = Image.alpha_composite(img, tri_glow)
    draw = ImageDraw.Draw(img)
    
    # 实心多边形
    draw.polygon([p1, p2, p3], fill=(0, 230, 255, 255))
    
    # 顶边与斜边渐变闪光 (亮白高光点缀)
    draw.line([p1, p2], fill=(255, 255, 255, 230), width=4)
    draw.line([p1, p3], fill=(0, 180, 235, 200), width=4)
    draw.line([p2, p3], fill=(79, 172, 254, 230), width=4)

    # 中心反射粒子微光 (添加科技精致细节)
    draw.ellipse([345, 251, 355, 261], fill=(255, 255, 255, 240))
    
    return img

if __name__ == "__main__":
    os.makedirs("build", exist_ok=True)
    icon_img = create_app_icon(512)
    icon_img.save("build/icon.png", format="PNG")
    
    # 生成多尺寸包含的 .ico 文件
    sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    icon_img.save("build/icon.ico", format="ICO", sizes=sizes)
    print("Icon generated successfully at build/icon.png and build/icon.ico")
