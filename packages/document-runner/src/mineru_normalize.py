"""Bounded normalization of native MinerU output; no application semantics or invented geometry."""
from html.parser import HTMLParser
import math


class NormalizationError(Exception):
    def __init__(self, code="PARSER_FAILED"):
        super().__init__(code)
        self.code = code


def bounded_text(value, limit=65536):
    if not isinstance(value, str):
        raise NormalizationError()
    if len(value) > limit:
        raise NormalizationError("PARSER_LIMIT")
    return value


def native_box(value):
    if value is None:
        return None
    if not isinstance(value, (list, tuple)) or len(value) != 4 or any(
        type(v) not in (int, float) or not math.isfinite(v) for v in value
    ):
        raise NormalizationError()
    left, top, right, bottom = value
    if not (0 <= left < right <= 1 and 0 <= top < bottom <= 1):
        raise NormalizationError()
    return {"left": left, "top": top, "right": right, "bottom": bottom}


def natural_text(value, depth=0):
    if depth > 20:
        raise NormalizationError("PARSER_LIMIT")
    if isinstance(value, str):
        return bounded_text(value)
    if isinstance(value, list):
        if len(value) > 10000:
            raise NormalizationError("PARSER_LIMIT")
        parts = []
        length = 0
        for item in value:
            part = natural_text(item, depth + 1)
            length += len(part)
            if length > 65536:
                raise NormalizationError("PARSER_LIMIT")
            parts.append(part)
        return "".join(parts)
    if isinstance(value, dict):
        return natural_text(value.get("content", ""), depth + 1)
    return ""


class TableParser(HTMLParser):
    def __init__(self, page_budget, total_budget):
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.seen_table = False
        self.row = -1
        self.cells = []
        self.occupied = set()
        self.active = None
        self.page_budget = page_budget
        self.total_budget = total_budget
        self.row_count = 0
        self.column_count = 0

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            if self.seen_table:
                raise NormalizationError()
            self.seen_table = True
            self.depth += 1
            if self.depth != 1:
                raise NormalizationError()
        if self.depth != 1:
            return
        if tag == "tr":
            if self.active is not None:
                raise NormalizationError()
            self.row += 1
            if self.row >= 1000:
                raise NormalizationError("PARSER_LIMIT")
            self.row_count = max(self.row_count, self.row + 1)
        if tag in ("td", "th"):
            if self.active is not None:
                raise NormalizationError()
            if self.row < 0:
                self.row = 0
            attrs = dict(attrs)
            def span(key):
                raw = attrs.get(key, "1")
                if not str(raw).isdigit() or len(str(raw)) > 4:
                    raise NormalizationError()
                value = int(raw)
                if not 1 <= value <= 1000:
                    raise NormalizationError("PARSER_LIMIT")
                return value
            col = 0
            while (self.row, col) in self.occupied:
                col += 1
            rowspan, colspan = span("rowspan"), span("colspan")
            if self.row + rowspan > 1000 or col + colspan > 1000:
                raise NormalizationError("PARSER_LIMIT")
            self.page_budget["cells"] += 1
            self.total_budget["slots"] += rowspan * colspan
            if self.page_budget["cells"] > 5000 or self.total_budget["slots"] > 100000:
                raise NormalizationError("PARSER_LIMIT")
            self.active = {"row": self.row, "col": col, "rowSpan": rowspan, "colSpan": colspan, "parts": [], "length": 0}
        if tag == "br" and self.active is not None:
            self.handle_data("\n")

    def handle_data(self, data):
        if self.depth == 1 and self.active is not None:
            self.active["length"] += len(data)
            if self.active["length"] > 65536:
                raise NormalizationError("PARSER_LIMIT")
            self.active["parts"].append(data)

    def handle_endtag(self, tag):
        if self.depth == 1 and tag in ("td", "th"):
            if self.active is None:
                raise NormalizationError()
            cell = self.active
            for row in range(cell["row"], cell["row"] + cell["rowSpan"]):
                for col in range(cell["col"], cell["col"] + cell["colSpan"]):
                    if (row, col) in self.occupied:
                        raise NormalizationError()
                    self.occupied.add((row, col))
            self.row_count = max(self.row_count, cell["row"] + cell["rowSpan"])
            self.column_count = max(self.column_count, cell["col"] + cell["colSpan"])
            cell["text"] = "".join(cell.pop("parts"))
            del cell["length"]
            self.cells.append(cell)
            self.active = None
        if tag == "table":
            if self.depth != 1 or self.active is not None:
                raise NormalizationError()
            self.depth -= 1

    def finish(self):
        self.close()
        if not self.seen_table or self.depth or self.active is not None:
            raise NormalizationError()
        return self.cells


def normalize(middle, selected):
    native_pages = middle.get("pages")
    if not isinstance(native_pages, list) or len(native_pages) != len(selected):
        raise NormalizationError()
    dimensions = {}
    for info in middle.get("extensions", {}).get("docvortex_layout", {}).get("pages", []):
        dimensions[info.get("page_idx")] = info
    pages = {}
    total_budget = {"slots": 0}
    for native in native_pages:
        page_index = native.get("page_idx")
        if type(page_index) is not int or page_index + 1 not in selected or page_index in pages:
            raise NormalizationError()
        page_number = page_index + 1
        result = {"page": page_number, "blocks": [], "tables": [], "warnings": []}
        size = dimensions.get(page_index, {})
        for source_key, target_key in (("width_pt", "widthPoints"), ("height_pt", "heightPoints")):
            value = size.get(source_key)
            if value is not None:
                if type(value) not in (int, float) or not math.isfinite(value) or not 0 < value <= 144000:
                    raise NormalizationError()
                result[target_key] = value
        blocks = native.get("blocks", [])
        if not isinstance(blocks, list) or len(blocks) > 1000:
            raise NormalizationError("PARSER_LIMIT")
        page_budget = {"cells": 0}
        for order, block in enumerate(blocks):
            kind = bounded_text(block.get("type"), 128)
            bbox = native_box(block.get("bbox"))
            normalized = {"id": f"p{page_number}-b{order}", "order": order, "type": kind,
                          "text": "" if kind == "table" else natural_text(block.get("content", ""))}
            if bbox is not None:
                normalized["bbox"] = bbox
            if kind == "table":
                content = block.get("content", [])
                if not isinstance(content, list) or len(content) > 1000:
                    raise NormalizationError("PARSER_LIMIT")
                for body_index, body in enumerate(content):
                    if body.get("type") != "table_body":
                        continue
                    raw = bounded_text(body.get("content"), 8 * 1024 * 1024)
                    parser = TableParser(page_budget, total_budget)
                    parser.feed(raw)
                    cells = parser.finish()
                    if len(result["tables"]) >= 1000:
                        raise NormalizationError("PARSER_LIMIT")
                    identifier = f"p{page_number}-b{order}-t{len(result['tables'])}"
                    native_index = block.get("index")
                    if type(native_index) is not int or not 0 <= native_index <= 100000:
                        native_index = order
                    table = {"id": identifier, "order": order,
                             "sourceLocator": f"page:{page_number}/block:{native_index}/table:{body_index}",
                             "continuesPrevious": block.get("continues_prev") is True,
                             "rowCount": parser.row_count, "columnCount": parser.column_count, "cells": cells}
                    table_box = native_box(body.get("bbox")) or bbox
                    if table_box is not None:
                        table["bbox"] = table_box
                    result["tables"].append(table)
                    normalized.setdefault("tableId", identifier)
            result["blocks"].append(normalized)
        if not any(b["text"].strip() for b in result["blocks"]) and not any(
            c["text"].strip() for table in result["tables"] for c in table["cells"]
        ):
            result["warnings"].append("NO_RECOGNIZED_CONTENT")
        pages[page_index] = result
    return {"parser": {"name": "mineru", "version": "4.0.12", "tier": "basic"},
            "pages": [pages[page - 1] for page in selected]}
