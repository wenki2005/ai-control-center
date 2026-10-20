import { extname } from 'node:path';

// QQ is a presentation channel, not a general-purpose file transfer path.
// Keep unusual/generated formats in the archive and only share familiar
// reading formats with the user.
export const QQ_SHAREABLE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif',
  '.md', '.markdown', '.txt', '.rtf', '.csv', '.tsv',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
]);

// Content hashes, UUIDs and timestamp-only names are useful archive keys but
// are not useful filenames for a person receiving a QQ attachment. Require a
// human-readable stem before anything can enter the QQ delivery queue.
export function hasHumanReadableName(artifact) {
  const name = String(artifact?.name || '').replace(/\\/g, '/').split('/').pop() || '';
  let stem = name.slice(0, Math.max(0, name.length - extname(name).length)).trim();
  if (!stem) return false;

  // Extraction often preserves the original extension in the text filename.
  // Those are processing artifacts (for example `report.pdf.txt`), not a
  // deliverable document to send as an attachment.
  if (/\.(?:pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|bmp|tiff?)$/i.test(stem)) return false;

  // Task archive summaries are internal bookkeeping even when their suffix
  // contains ordinary Chinese words.
  if (/^task[-_]t[-_][a-z0-9_-]+/i.test(stem)) return false;

  // Drop common leading date/time markers before looking for a real title.
  // Supports YYYY-MM-DD, YYYYMMDD and the common YYYY-MMDD export form.
  stem = stem.replace(/^\d{4}(?:[-_.]\d{1,2}[-_.]\d{1,2}|[-_.]\d{4}|\d{4})(?:[T _-]\d{2}(?:[-_:]?\d{2}){0,2})?/, '');

  // UUIDs and long hexadecimal hashes are archive identifiers. Remove them
  // wherever they occur so a title must remain after generated tokens vanish.
  stem = stem
    .replace(/(?<![0-9a-f])[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?![0-9a-f])/ig, '')
    .replace(/(?<![0-9a-f])[0-9a-f]{24,}(?![0-9a-f])/ig, '');

  // Ignore conventional copy markers and numeric duplicate suffixes; a bare
  // number or a filename consisting only of a copy marker is not a title.
  stem = stem
    .replace(/[\s._-]*[（(]\d+[）)]$/, '')
    .replace(/(?:[\s._-]*(?:副本|copy|复制)(?:[\s._-]*\d+)?)$/i, '')
    .replace(/[\s._-]+/g, ' ')
    .trim();

  if (!stem || /^[0-9]+(?:[-_. ]+[0-9]+)*$/.test(stem)) return false;
  // A remaining Chinese title or alphabetic word is human-readable. Short
  // acronyms such as `AI` are valid titles too; numeric/hash-only residue is not.
  return /[\u3400-\u9fff]/u.test(stem) || /[a-z]{2,}/i.test(stem);
}

export function isQqShareableArtifact(artifact) {
  if (!hasHumanReadableName(artifact)) return false;
  const extension = extname(String(artifact?.name || '')).toLowerCase();
  if (!QQ_SHAREABLE_EXTENSIONS.has(extension)) return false;
  // A known image extension must still be identified as an image before using
  // QQ's image transport. Unknown binary files are never promoted by MIME alone.
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif'].includes(extension)) {
    return artifact?.isImage === true || /^image\//i.test(String(artifact?.mimeType || ''));
  }
  return true;
}

// Specialist catalogs and repair reports are useful inside the archive, but
// they are machine-facing records rather than user deliverables. Keep them
// out of automatic QQ attachment selection even if a task is linked through a
// native DSH worker and appears as an ordinary worker to the report queue.
export function isInternalArtifact(artifact) {
  const source = String(artifact?.sourcePath || artifact?.path || '').replace(/\\/g, '/');
  return /(?:^|\/)_(?:librarian|maintenance)(?:\/|$)/i.test(source)
    || /(?:^|\/)outputs\/t-[^/]+\/(?:catalog|repair)\.json$/i.test(source)
    || /^(?:catalog|repair)\.json$/i.test(String(artifact?.name || ''));
}
