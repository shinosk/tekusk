// Minimal dependency-free CSV parser (RFC4180-ish: handles quoted fields,
// escaped quotes, CRLF). Returns { header: string[], rows: string[][] }.

export function parseCsv(text) {
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const pushField = () => {
    record.push(field);
    field = '';
  };
  const pushRecord = () => {
    // Ignore a trailing empty line
    if (record.length === 1 && record[0] === '' ) {
      record = [];
      return;
    }
    rows.push(record);
    record = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      pushField();
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      pushField();
      pushRecord();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // flush last field/record if any content remains
  if (field !== '' || record.length > 0) {
    pushField();
    pushRecord();
  }

  const header = rows.shift() || [];
  return { header, rows };
}

// Parse a numeric cell. The upstream dataset uses the literal string "nan"
// for missing values; treat those (and blanks) as null.
export function parseNumber(cell) {
  if (cell == null) return null;
  const s = String(cell).trim();
  if (s === '' || s.toLowerCase() === 'nan' || s.toLowerCase() === 'na') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}
