import json
import sys
from contextlib import contextmanager
from pathlib import Path

from PIL import Image, ImageOps, ImageChops

LANCZOS = getattr(getattr(Image, 'Resampling', Image), 'LANCZOS')

def exif_transpose(image):
    transpose = getattr(ImageOps, 'exif_transpose', None)
    if transpose is not None:
        return transpose(image)
    try:
        exif = image._getexif()
        orientation = exif.get(274) if exif else None
    except (AttributeError, TypeError, ValueError):
        orientation = None
    operations = {
        2: Image.FLIP_LEFT_RIGHT,
        3: Image.ROTATE_180,
        4: Image.FLIP_TOP_BOTTOM,
        5: Image.TRANSPOSE,
        6: Image.ROTATE_270,
        7: Image.TRANSVERSE,
        8: Image.ROTATE_90,
    }
    return image.transpose(operations[orientation]) if orientation in operations else image.copy()


def prepare(directory, remove_background=False):
    with Image.open(directory / 'source.png') as source:
        if source.format not in ('PNG', 'JPEG', 'WEBP'):
            raise ValueError('Only PNG, JPEG and WebP images are supported')
        if min(source.size) < 1:
            raise ValueError('Invalid input dimensions')
        image = exif_transpose(source).convert('RGBA')
    image.save(directory / 'source.png', format='PNG')
    background = Image.new('RGBA', image.size, (255, 255, 255, 255))
    Image.alpha_composite(background, image).convert('RGB').save(directory / 'input.png')
    print(json.dumps({'width': image.width, 'height': image.height}))


@contextmanager
def open_generated_image(filename, width, height):
    previous_limit = Image.MAX_IMAGE_PIXELS
    try:
        Image.MAX_IMAGE_PIXELS = max(previous_limit or 0, width * height)
        image = Image.open(filename)
    finally:
        Image.MAX_IMAGE_PIXELS = previous_limit
    with image:
        if image.size != (width, height):
            raise ValueError('ComfyUI returned unexpected output dimensions')
        yield image


def finish(directory, width, height, remove_background=False):
    if width < 1 or height < 1:
        raise ValueError('Invalid output dimensions')
    with Image.open(directory / 'source.png') as source, open_generated_image(directory / 'generated.png', width, height) as generated:
        result = generated.convert('RGBA')
        alpha = source.convert('RGBA').getchannel('A').resize((width, height), LANCZOS)
        if remove_background:
            if 'A' not in generated.getbands() or source.size != generated.size:
                raise ValueError('Background removal must return original-sized RGBA')
            alpha = ImageChops.multiply(alpha, result.getchannel('A'))
            result = source.convert('RGBA')
        result.putalpha(alpha)
        result.save(directory / 'result.png', format='PNG')
        print(json.dumps({'width': width, 'height': height}))


if __name__ == '__main__':
    action = sys.argv[1]
    folder = Path(sys.argv[2])
    if action in ('prepare', 'prepare-background'):
        prepare(folder, action == 'prepare-background')
    elif action in ('finish', 'finish-background'):
        finish(folder, int(sys.argv[3]), int(sys.argv[4]), action == 'finish-background')
    else:
        raise ValueError('Unknown action')
