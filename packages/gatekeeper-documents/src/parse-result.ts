import type {
  DocumentBlock, DocumentBox, DocumentParsedPage, DocumentParser, DocumentTable,
} from "./types.js";

function fail(): never { throw new Error("Invalid structured document result."); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return fail();
  return value;
}
function text(value: unknown, max: number, nonempty = false): string {
  if (typeof value !== "string" || value.length > max || (nonempty && !value.length)) return fail();
  return value;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) return fail();
  return value;
}
function box(value: unknown): DocumentBox | undefined {
  if (value === undefined) return undefined;
  const raw = record(value);
  for (const name of ["left", "top", "right", "bottom"]) {
    if (typeof raw[name] !== "number" || !Number.isFinite(raw[name]) || raw[name] < 0 || raw[name] > 1) return fail();
  }
  const result = { left: raw.left as number, top: raw.top as number,
    right: raw.right as number, bottom: raw.bottom as number };
  if (result.left >= result.right || result.top >= result.bottom) return fail();
  return result;
}
function dimension(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000_000) return fail();
  return value;
}

/** Validate the parser identity separately from PDF metadata and recognized content. */
export function parseDocumentParser(value: unknown): DocumentParser {
  const raw = record(value);
  if (raw.name !== "mineru" || raw.tier !== "basic") return fail();
  const version = text(raw.version, 64, true);
  if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)) return fail();
  return { name: "mineru", tier: "basic", version };
}

/** Validate bounded native structure without inventing geometry, cells, or page associations. */
export function parseDocumentPages(value: unknown, pageCount: number): DocumentParsedPage[] {
  const pages = list(value, 20);
  const seenPages = new Set<number>();
  let slots = 0;
  return pages.map(pageValue => {
    const raw = record(pageValue);
    const page = integer(raw.page, 1, pageCount);
    if (seenPages.has(page)) return fail();
    seenPages.add(page);
    let cells = 0;
    const tableIds = new Set<string>();
    const tables: DocumentTable[] = list(raw.tables, 1000).map(tableValue => {
      const t = record(tableValue);
      const id = text(t.id, 128, true);
      if (tableIds.has(id)) return fail();
      tableIds.add(id);
      const order = integer(t.order, 0, 100_000);
      const sourceLocator = text(t.sourceLocator, 512, true);
      // This is provenance in the parser's document, never a backend path or URL.
      if (!/^page:\d+\/block:\d+\/table:\d+$/.test(sourceLocator) ||
          Number(sourceLocator.split("/")[0].slice(5)) !== page) return fail();
      if (typeof t.continuesPrevious !== "boolean") return fail();
      const rowCount = integer(t.rowCount, 0, 1000);
      const columnCount = integer(t.columnCount, 0, 1000);
      const bbox = box(t.bbox);
      const occupied = new Set<number>();
      const parsedCells = list(t.cells, 5000).map(cellValue => {
        const c = record(cellValue);
        // MinerU Basic supplies no native cell coordinates; do not lend invented ones authority.
        if (c.bbox !== undefined) return fail();
        if (++cells > 5000) return fail();
        const row = integer(c.row, 0, 999), col = integer(c.col, 0, 999);
        const rowSpan = integer(c.rowSpan, 1, 1000), colSpan = integer(c.colSpan, 1, 1000);
        if (row + rowSpan > rowCount || col + colSpan > columnCount) return fail();
        slots += rowSpan * colSpan;
        if (slots > 100_000) return fail();
        for (let r = row; r < row + rowSpan; r++) {
          for (let colIndex = col; colIndex < col + colSpan; colIndex++) {
            const slot = r * 1000 + colIndex;
            if (occupied.has(slot)) return fail();
            occupied.add(slot);
          }
        }
        return { row, col, rowSpan, colSpan, text: text(c.text, 65_536) };
      });
      return { id, order, sourceLocator, continuesPrevious: t.continuesPrevious,
        rowCount, columnCount, cells: parsedCells, ...(bbox ? { bbox } : {}) };
    });
    const blockIds = new Set<string>();
    const blocks: DocumentBlock[] = list(raw.blocks, 1000).map(blockValue => {
      const b = record(blockValue);
      const id = text(b.id, 128, true);
      if (blockIds.has(id)) return fail();
      blockIds.add(id);
      const bbox = box(b.bbox);
      const tableId = b.tableId === undefined ? undefined : text(b.tableId, 128, true);
      if (tableId !== undefined && !tableIds.has(tableId)) return fail();
      return { id, order: integer(b.order, 0, 100_000), type: text(b.type, 128, true),
        text: text(b.text, 8 * 1024 * 1024), ...(bbox ? { bbox } : {}),
        ...(tableId !== undefined ? { tableId } : {}) };
    });
    const warnings = list(raw.warnings, 100).map(w => {
      const code = text(w, 128, true);
      if (!/^[A-Z][A-Z0-9_]*$/.test(code)) return fail();
      return code;
    });
    const widthPoints = dimension(raw.widthPoints), heightPoints = dimension(raw.heightPoints);
    return { page, blocks, tables, warnings, ...(widthPoints !== undefined ? { widthPoints } : {}),
      ...(heightPoints !== undefined ? { heightPoints } : {}) };
  });
}
