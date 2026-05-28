/**
 * Converts markdown table blocks in a string to box-draw Unicode tables.
 * Detects consecutive lines matching "| col | col |" separated by a
 * "|---|----|" separator row.
 */

const BOX = {
  top: '─', bottom: '─',
  left: '│', right: '│',
  tl: '┌', tr: '┐', bl: '└', br: '┘',
  mid: '┼', topMid: '┬', bottomMid: '┴', leftMid: '├', rightMid: '┤',
} as const;

function isSepRow(line: string): boolean {
  return /^\|[\s\-:]+\|/.test(line);
}

function isTableRow(line: string): boolean {
  return /^\|.+\|/.test(line);
}

function parseRow(line: string): string[] {
  return line
    .replace(/^\|\s*/, '')
    .replace(/\s*\|$/, '')
    .split('|')
    .map(c => c.trim());
}

function padCell(content: string, width: number): string {
  return content + ' '.repeat(Math.max(0, width - content.length));
}

interface TableBlock {
  rows: string[][];
}

function extractTables(text: string): { tables: TableBlock[]; spans: Array<{ start: number; end: number }> } {
  const lines = text.split('\n');
  const tables: TableBlock[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  let i = 0;

  while (i < lines.length) {
    // Find a header line followed by a separator
    if (i + 1 < lines.length && isTableRow(lines[i]!) && isSepRow(lines[i + 1]!)) {
      const start = i;
      const rows: string[][] = [];
      rows.push(parseRow(lines[i]!));   // header
      i++;                              // skip separator
      i++;
      // Collect data rows
      while (i < lines.length && isTableRow(lines[i]!)) {
        rows.push(parseRow(lines[i]!));
        i++;
      }
      tables.push({ rows });
      spans.push({ start, end: i });
    } else {
      i++;
    }
  }
  return { tables, spans };
}

function drawTable(rows: string[][]): string {
  const colCount = Math.max(...rows.map(r => r.length));
  const colWidths: number[] = Array(colCount).fill(0);
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      colWidths[c] = Math.max(colWidths[c]!, (row[c] ?? '').length);
    }
  }

  const pad = (row: string[]) =>
    row.map((cell, c) => padCell(cell, colWidths[c]!)).join(` ${BOX.left} `);

  const sep = (l: string, m: string, r: string) =>
    l + colWidths.map(w => BOX.top.repeat(w + 2)).join(m) + r;

  const out: string[] = [];
  out.push(sep(BOX.tl, BOX.topMid, BOX.tr));
  out.push(`${BOX.left} ${pad(rows[0]!)} ${BOX.right}`);  // header
  out.push(sep(BOX.leftMid, BOX.mid, BOX.rightMid));       // separator

  for (let r = 1; r < rows.length; r++) {
    out.push(`${BOX.left} ${pad(rows[r]!)} ${BOX.right}`);
  }
  out.push(sep(BOX.bl, BOX.bottomMid, BOX.br));

  return out.join('\n');
}

export function renderTables(text: string): string {
  const { tables, spans } = extractTables(text);
  if (tables.length === 0) return text;

  const lines = text.split('\n');
  const result: string[] = [];
  let cursor = 0;

  for (let t = 0; t < tables.length; t++) {
    const span = spans[t]!;
    // Copy lines before this table
    result.push(...lines.slice(cursor, span.start));
    // Insert rendered table
    result.push(drawTable(tables[t]!.rows));
    cursor = span.end;
  }
  // Copy remaining lines
  result.push(...lines.slice(cursor));

  return result.join('\n');
}
