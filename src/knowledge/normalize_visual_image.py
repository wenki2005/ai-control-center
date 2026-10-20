import json
import os
import sys
import warnings

MAX_INPUT = 20 * 1024 * 1024
MAX_PIXELS = 40_000_000
MAX_DIMENSION = 1800
MAX_OUTPUT = 8 * 1024 * 1024
FORMATS = {
    'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WEBP',
    'image/gif': 'GIF', 'image/bmp': 'BMP', 'image/tiff': 'TIFF',
}


def main():
    try:
        from PIL import Image, ImageFile
    except Exception as exc:
        raise ValueError('Pillow is unavailable for visual image normalization') from exc
    request = json.load(sys.stdin)
    filename = request.get('path')
    output_directory = request.get('outputDirectory')
    expected = request.get('expectedMimeType')
    if not isinstance(filename, str) or not os.path.isabs(filename):
        raise ValueError('absolute image path required')
    if not isinstance(output_directory, str) or not os.path.isabs(output_directory):
        raise ValueError('absolute image output directory required')
    if expected not in FORMATS:
        raise ValueError('unsupported image MIME type')
    if not os.path.isfile(filename) or os.path.getsize(filename) < 1 or os.path.getsize(filename) > MAX_INPUT:
        raise ValueError('image is missing or exceeds the 20 MB input limit')

    ImageFile.LOAD_TRUNCATED_IMAGES = False
    with warnings.catch_warnings():
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        with Image.open(filename) as probe:
            if probe.format != FORMATS[expected]:
                raise ValueError('image content does not match its declared MIME type')
            if probe.width < 1 or probe.height < 1 or probe.width * probe.height > MAX_PIXELS:
                raise ValueError('image exceeds the 40 megapixel limit')
            probe.verify()
        with Image.open(filename) as source:
            source.seek(0)
            source.load()
            rgba = source.convert('RGBA')
            background = Image.new('RGBA', rgba.size, (255, 255, 255, 255))
            image = Image.alpha_composite(background, rgba).convert('RGB')
            image.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.Resampling.LANCZOS)
            os.makedirs(output_directory, exist_ok=True)
            output_path = os.path.join(output_directory, 'visual-image.jpg')
            for quality in (88, 78, 68, 58):
                image.save(output_path, format='JPEG', quality=quality, optimize=True)
                if os.path.getsize(output_path) <= MAX_OUTPUT:
                    break
                image.thumbnail((max(1, image.width * 3 // 4), max(1, image.height * 3 // 4)), Image.Resampling.LANCZOS)
            if os.path.getsize(output_path) > MAX_OUTPUT:
                raise ValueError('normalized image exceeds the 8 MB output limit')
    print(json.dumps({'status': 'ok', 'path': output_path}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'status': 'error', 'error': str(exc)[:300]}))
        sys.exit(1)
