import argparse
import math
import pathlib
import subprocess

import imageio_ffmpeg
import numpy as np
from PIL import Image


def build_assets(logo):
    output = pathlib.Path(__file__).resolve().parents[1] / "public" / "brand"
    output.mkdir(parents=True, exist_ok=True)
    with Image.open(logo) as image:
        image.convert("RGB").resize((320, 320), Image.Resampling.LANCZOS).save(output / "resona-logo.webp", quality=95)
    width, height, fps, duration = 768, 432, 24, 12
    horizontal, vertical = np.meshgrid(np.linspace(-1.7, 1.7, width), np.linspace(-1, 1, height))
    colors = np.array([[0.08, 0.27, 0.95], [0.04, 0.76, 0.81], [0.8, 0.47, 0.17], [0.51, 0.21, 0.85]])
    command = [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}", "-r", str(fps), "-i", "-", "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output / "home-flow.mp4")]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        for frame_index in range(fps * duration):
            phase = frame_index / (fps * duration) * math.tau
            image = np.zeros((height, width, 3), dtype=np.float64) + np.array([0.025, 0.035, 0.075])
            for color_index, color in enumerate(colors):
                offset = phase + color_index * math.pi / 2
                center_x = math.cos(offset) * 1.05
                center_y = math.sin(offset) * 0.58
                bend = 0.24 * np.sin(horizontal * 1.7 + offset)
                glow = np.exp(-((horizontal - center_x) ** 2 / 0.85 + (vertical - center_y - bend) ** 2 / 0.32))
                image += glow[:, :, None] * color * 0.76
            ribbon = np.exp(-((vertical - 0.23 * np.sin(horizontal * 2.1 + phase)) ** 2) / 0.014)
            image += ribbon[:, :, None] * np.array([0.025, 0.10, 0.15])
            pixels = (np.clip(image, 0, 1) * 255).astype(np.uint8)
            if frame_index == 0:
                Image.fromarray(pixels).save(output / "home-flow-poster.jpg", quality=88)
            process.stdin.write(pixels.tobytes())
    finally:
        process.stdin.close()
    if process.wait() != 0:
        raise RuntimeError("背景视频编码失败")
    print(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("logo")
    build_assets(parser.parse_args().logo)
