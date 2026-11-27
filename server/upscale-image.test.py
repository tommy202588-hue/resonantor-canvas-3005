import importlib.util
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from PIL import Image


spec = importlib.util.spec_from_file_location('upscale_image', Path(__file__).with_name('upscale-image.py'))
processor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(processor)


class BackgroundImageTests(unittest.TestCase):
    def test_prepare_works_without_new_exif_transpose_helper(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            Image.new('RGB', (8, 6), (120, 80, 40)).save(folder / 'source.png')
            with patch.object(processor.ImageOps, 'exif_transpose', None, create=True):
                processor.prepare(folder)
            with Image.open(folder / 'input.png') as prepared:
                self.assertEqual(prepared.size, (8, 6))

    def test_large_images_preserve_size_color_and_alpha(self):
        for size in [(4096, 32), (9000, 4)]:
            with self.subTest(size=size), tempfile.TemporaryDirectory() as temporary:
                folder = Path(temporary)
                Image.new('RGBA', size, (120, 80, 40, 128)).save(folder / 'source.png')
                processor.prepare(folder, remove_background=True)
                with Image.open(folder / 'input.png') as prepared:
                    self.assertEqual(prepared.size, size)
                Image.new('RGBA', size, (255, 255, 255, 128)).save(folder / 'generated.png')
                processor.finish(folder, *size, remove_background=True)
                with Image.open(folder / 'result.png') as result:
                    self.assertEqual(result.size, size)
                    self.assertEqual(result.mode, 'RGBA')
                    self.assertEqual(result.getpixel((0, 0)), (120, 80, 40, 64))

    def test_large_upscales_preserve_expected_dimensions_and_alpha(self):
        for scale in (2, 4):
            with self.subTest(scale=scale), tempfile.TemporaryDirectory() as temporary:
                folder = Path(temporary)
                size = (4800, 4)
                output = (size[0] * scale, size[1] * scale)
                Image.new('RGBA', size, (120, 80, 40, 128)).save(folder / 'source.png')
                processor.prepare(folder)
                Image.new('RGB', output, (50, 100, 150)).save(folder / 'generated.png')
                with patch.object(Image, 'MAX_IMAGE_PIXELS', 20000):
                    processor.finish(folder, *output)
                    self.assertEqual(Image.MAX_IMAGE_PIXELS, 20000)
                with Image.open(folder / 'result.png') as result:
                    self.assertEqual(result.size, output)
                    self.assertEqual(result.getpixel((0, 0)), (50, 100, 150, 128))

    def test_invalid_and_unexpected_output_dimensions_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            Image.new('RGBA', (4096, 4)).save(folder / 'source.png')
            processor.prepare(folder)
            with self.assertRaises(ValueError):
                processor.finish(folder, 0, 4)
            Image.new('RGBA', (4095, 4)).save(folder / 'generated.png')
            with self.assertRaisesRegex(ValueError, 'unexpected output dimensions'):
                processor.finish(folder, 4096, 4, remove_background=True)
            with self.assertRaisesRegex(ValueError, 'unexpected output dimensions'):
                processor.finish(folder, 8192, 8)

    def test_generated_image_limit_restores_after_open_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Image, 'MAX_IMAGE_PIXELS', 20000):
                with self.assertRaises(FileNotFoundError):
                    with processor.open_generated_image(Path(temporary) / 'missing.png', 19200, 25600):
                        self.fail('Missing image must not open')
                self.assertEqual(Image.MAX_IMAGE_PIXELS, 20000)


if __name__ == '__main__':
    unittest.main()
