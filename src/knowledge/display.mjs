// Presentation-only aliases for the personal file library.  The archive keeps
// the original bytes, paths and extracted text so provenance and hashes remain
// auditable; this helper is applied only to records returned to library views.
const LEGACY_NAME = /(?:月港\s*729|Moonport\s*729)/giu;

export function libraryDisplayText(value) {
  return typeof value === 'string' ? value.replace(LEGACY_NAME, '共忆') : value;
}

export function displayArtifact(record) {
  if (!record || typeof record !== 'object') return record;
  const visible = { ...record };
  for (const key of ['name', 'excerpt', 'text']) visible[key] = libraryDisplayText(visible[key]);
  if (record.catalog && typeof record.catalog === 'object') {
    visible.catalog = {
      ...record.catalog,
      title: libraryDisplayText(record.catalog.title),
      summary: libraryDisplayText(record.catalog.summary),
      tags: Array.isArray(record.catalog.tags) ? record.catalog.tags.map(libraryDisplayText) : record.catalog.tags,
    };
  }
  if (Array.isArray(record.media)) visible.media = record.media.map((item) => ({
    ...item,
    alt: libraryDisplayText(item?.alt),
  }));
  return visible;
}

export function displayArtifacts(records = []) {
  return Array.isArray(records) ? records.map(displayArtifact) : records;
}
