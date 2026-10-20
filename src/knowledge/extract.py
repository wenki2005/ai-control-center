import json
import os
import re
import sys
import zipfile
from xml.etree import ElementTree

MAX_MEMBERS = 1000
MAX_TOTAL = 50 * 1024 * 1024
MAX_MEMBER = 5 * 1024 * 1024
MAX_TEXT = 2_000_000
FORBIDDEN_XML = re.compile(br'<!\s*(?:DOCTYPE|ENTITY)', re.I)


def xml_text(data):
    if FORBIDDEN_XML.search(data):
        raise ValueError('XML with DTD or entity declarations is forbidden')
    root = ElementTree.fromstring(data)
    return ' '.join((node.text or '').strip() for node in root.iter() if node.text and node.text.strip())


def bounded_read(archive, item):
    if item.file_size > MAX_MEMBER:
        raise ValueError('document member exceeds extraction limit')
    with archive.open(item) as stream:
        data = stream.read(MAX_MEMBER + 1)
    if len(data) > MAX_MEMBER:
        raise ValueError('document member exceeds extraction limit')
    return data


def office_text(filename):
    with zipfile.ZipFile(filename) as archive:
        items = archive.infolist()
        if len(items) > MAX_MEMBERS:
            raise ValueError('document contains too many ZIP members')
        total = 0
        safe = {}
        for item in items:
            name = item.filename.replace('\\', '/')
            if name.startswith('/') or '..' in name.split('/'):
                raise ValueError('unsafe ZIP member path')
            total += item.file_size
            if item.file_size > MAX_MEMBER or total > MAX_TOTAL:
                raise ValueError('document exceeds ZIP extraction limits')
            if not item.is_dir():
                safe[name] = item

        ext = os.path.splitext(filename)[1].lower()
        if ext == '.docx':
            names = ['word/document.xml'] + sorted(n for n in safe if re.fullmatch(r'word/(?:header|footer)\d+\.xml', n))
        elif ext == '.pptx':
            names = sorted((n for n in safe if re.fullmatch(r'ppt/slides/slide\d+\.xml', n)), key=lambda n: int(re.search(r'slide(\d+)', n).group(1)))
        else:
            names = []
            shared = []
            if 'xl/sharedStrings.xml' in safe:
                data = bounded_read(archive, safe['xl/sharedStrings.xml'])
                root = ElementTree.fromstring(data) if not FORBIDDEN_XML.search(data) else None
                if root is None:
                    raise ValueError('XML with DTD or entity declarations is forbidden')
                shared = [''.join(node.text or '' for node in si.iter() if node.tag.endswith('}t')) for si in root if si.tag.endswith('}si')]
            for n in sorted((n for n in safe if re.fullmatch(r'xl/worksheets/sheet\d+\.xml', n)), key=lambda n: int(re.search(r'sheet(\d+)', n).group(1))):
                data = bounded_read(archive, safe[n])
                if FORBIDDEN_XML.search(data):
                    raise ValueError('XML with DTD or entity declarations is forbidden')
                root = ElementTree.fromstring(data)
                cells = []
                for cell in root.iter():
                    if cell.tag.endswith('}c'):
                        if cell.attrib.get('t') == 'inlineStr':
                            inline = next((child for child in cell if child.tag.endswith('}is')), None)
                            if inline is not None:
                                cells.append(''.join(node.text or '' for node in inline.iter() if node.tag.endswith('}t')))
                            continue
                        value = next((child for child in cell if child.tag.endswith('}v')), None)
                        if value is not None:
                            raw = value.text or ''
                            if cell.attrib.get('t') == 's' and raw.isdigit() and int(raw) < len(shared):
                                raw = shared[int(raw)]
                            cells.append(raw)
                if cells:
                    names.append((n, '\t'.join(cells)))
            return '\n'.join(value for _, value in names)[:MAX_TEXT]
        chunks = []
        for name in names:
            if name not in safe:
                continue
            chunks.append(xml_text(bounded_read(archive, safe[name])))
        return '\n'.join(chunks)[:MAX_TEXT]


def pdf_text(filename):
    try:
        from pypdf import PdfReader
    except Exception as exc:
        raise ValueError('PDF text extraction requires pypdf') from exc
    reader = PdfReader(filename, strict=True)
    if len(reader.pages) > 500:
        raise ValueError('PDF contains too many pages')
    output = []
    length = 0
    for page in reader.pages:
        part = page.extract_text() or ''
        length += len(part)
        if length > MAX_TEXT:
            raise ValueError('PDF extracted text exceeds limit')
        output.append(part)
    return '\n'.join(output).strip()


def image_text(filename):
    # Raster images are retained as visual artifacts and are passed to the
    # connected multimodal model on demand. Never run local OCR implicitly.
    return ''


def main():
    try:
        request = json.load(sys.stdin)
        filename = request.get('path')
        if not isinstance(filename, str) or not os.path.isabs(filename):
            raise ValueError('absolute path required')
        ext = os.path.splitext(filename)[1].lower()
        if ext == '.pdf':
            text = pdf_text(filename)
        elif ext in ('.bmp', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp'):
            text = image_text(filename)
        elif ext in ('.docx', '.xlsx', '.pptx'):
            text = office_text(filename)
        else:
            raise ValueError('unsupported extraction type')
        if len(text) > MAX_TEXT:
            raise ValueError('extracted text exceeds limit')
        print(json.dumps({'status': 'ok', 'text': text}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'status': 'error', 'error': str(exc)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
