import json
import os
import sys

MAX_FILE = 20 * 1024 * 1024
MAX_PAGES = 500
MAX_RENDERED_PAGES = 4
MAX_DIMENSION = 1800
MAX_IMAGE_BYTES = 8 * 1024 * 1024


def main():
    request = json.load(sys.stdin)
    filename = request.get('path')
    output_directory = request.get('outputDirectory')
    if not isinstance(filename, str) or not os.path.isabs(filename):
        raise ValueError('absolute PDF path required')
    if not isinstance(output_directory, str) or not os.path.isabs(output_directory):
        raise ValueError('absolute render directory required')
    if not os.path.isfile(filename) or os.path.getsize(filename) > MAX_FILE:
        raise ValueError('PDF is missing or exceeds the 20 MB render limit')

    try:
        import pypdfium2 as pdfium
    except Exception as exc:
        raise ValueError('PDFium is unavailable for visual page rendering') from exc

    document = pdfium.PdfDocument(filename)
    count = len(document)
    if count < 1 or count > MAX_PAGES:
        raise ValueError('PDF page count is outside the supported 1–500 page range')
    requested = request.get('pages')
    if requested is None:
        pages = list(range(1, min(count, MAX_RENDERED_PAGES) + 1))
    elif (not isinstance(requested, list) or not 1 <= len(requested) <= MAX_RENDERED_PAGES
          or any(not isinstance(page, int) or page < 1 or page > count for page in requested)):
        raise ValueError('requested PDF page is outside the document or exceeds four pages')
    else:
        pages = list(dict.fromkeys(requested))

    os.makedirs(output_directory, exist_ok=True)
    images = []
    for number in pages:
        page = document[number - 1]
        width, height = page.get_size()
        if width <= 0 or height <= 0:
            raise ValueError('PDF contains an invalid page size')
        scale = min(2.0, MAX_DIMENSION / max(width, height))
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil()
        image.thumbnail((MAX_DIMENSION, MAX_DIMENSION))
        output_path = os.path.join(output_directory, 'page-%03d.jpg' % number)
        image.save(output_path, format='JPEG', quality=82, optimize=True)
        if os.path.getsize(output_path) > MAX_IMAGE_BYTES:
            image.thumbnail((1200, 1200))
            image.save(output_path, format='JPEG', quality=68, optimize=True)
        if os.path.getsize(output_path) > MAX_IMAGE_BYTES:
            raise ValueError('rendered PDF page exceeds the 8 MB image limit')
        images.append({'page': number, 'path': output_path})
        page.close()
        bitmap.close()
    document.close()
    print(json.dumps({'status': 'ok', 'images': images}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'status': 'error', 'error': str(exc)[:300]}, ensure_ascii=False))
        sys.exit(1)
