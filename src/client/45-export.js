/**
 * Result export: CSV, a minimal XLSX writer and an INSERT script.
 *
 * Browsers cannot write to an arbitrary path on their own, so `dwSaveFile` uses the
 * File System Access API (`showSaveFilePicker`) when the host provides it — that is
 * what lets the user pick the directory and file name. Where it is unavailable the
 * file is downloaded instead, and the caller reports that in the run log.
 *
 * Everything here is pure except the save step: nothing is sent to the database,
 * and the XLSX is assembled by hand (a stored-entry ZIP) so the bundle stays free of
 * third-party archives.
 */

const DW_CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function dwCrc32(bytes) {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) crc = DW_CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dwConcatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** A ZIP with stored (uncompressed) entries, which is all an XLSX needs. */
function dwZipStore(files) {
  const encoder = new TextEncoder()
  const entries = files.map((file) => ({
    name: encoder.encode(file.name),
    data: typeof file.data === 'string' ? encoder.encode(file.data) : file.data,
  }))
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const entry of entries) {
    const crc = dwCrc32(entry.data)
    const local = new Uint8Array(30 + entry.name.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0x0800, true)
    localView.setUint16(8, 0, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, entry.data.length, true)
    localView.setUint32(22, entry.data.length, true)
    localView.setUint16(26, entry.name.length, true)
    local.set(entry.name, 30)
    localParts.push(local, entry.data)

    const central = new Uint8Array(46 + entry.name.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 0x0800, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, entry.data.length, true)
    centralView.setUint32(24, entry.data.length, true)
    centralView.setUint16(28, entry.name.length, true)
    centralView.setUint32(42, offset, true)
    central.set(entry.name, 46)
    centralParts.push(central)
    offset += local.length + entry.data.length
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)
  return dwConcatBytes([...localParts, ...centralParts, end])
}

/** One value as text for CSV: NULL becomes an empty field, quotes doubled. */
function dwCsvField(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** CSV text with a BOM, so Excel opens UTF-8 Chinese columns correctly. */
export function dwCsvText(columns, rows) {
  const header = columns.map((column) => dwCsvField(column.name)).join(',')
  const body = rows.map((row) => columns.map((column, index) => dwCsvField(row[index])).join(','))
  return `\ufeff${[header, ...body].join('\r\n')}\r\n`
}

/** One SQL literal for the INSERT script (same rules as the UPDATE generator). */
function dwExportLiteral(value, numeric) {
  if (value === null || value === undefined) return 'NULL'
  const text = String(value)
  if (numeric === true && /^-?\d+(\.\d+)?$/.test(text.trim())) return text.trim()
  return `'${text.replace(/'/g, "''")}'`
}

/** INSERT statements for the displayed rows; the caller must know the table. */
export function dwInsertText(target, columns, rows, numeric) {
  const quote = (name) => `\`${String(name).replace(/`/g, '``')}\``
  const from = target.database === '' ? quote(target.table) : `${quote(target.database)}.${quote(target.table)}`
  const names = columns.map((column) => quote(column.name)).join(', ')
  return `${rows.map((row) => `INSERT INTO ${from} (${names}) VALUES (${columns.map((column, index) => dwExportLiteral(row[index], numeric[index])).join(', ')});`).join('\n')}\n`
}

function dwXmlEscape(text) {
  return String(text)
    .replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[character]))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

/** A1, B1 … AA1: spreadsheet column names for a cell reference. */
function dwColumnName(index) {
  let name = ''
  let rest = index
  while (rest >= 0) {
    name = String.fromCharCode(65 + (rest % 26)) + name
    rest = Math.floor(rest / 26) - 1
  }
  return name
}

function dwXlsxCell(reference, value, numeric) {
  if (value === null || value === undefined || value === '') return `<c r="${reference}"/>`
  const text = String(value)
  // Excel keeps only 15 significant digits; longer integers stay text so a BIGINT
  // id is not silently rounded.
  if (numeric === true && /^-?\d+(\.\d+)?$/.test(text) && text.replace(/[-.]/g, '').length <= 15) {
    return `<c r="${reference}"><v>${text}</v></c>`
  }
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${dwXmlEscape(text)}</t></is></c>`
}

/** An XLSX workbook with one worksheet, as bytes. */
export function dwXlsxBytes(columns, rows, numeric) {
  const sheetRows = [
    `<row r="1">${columns.map((column, index) => dwXlsxCell(`${dwColumnName(index)}1`, column.name)).join('')}</row>`,
    ...rows.map((row, rowIndex) => {
      const line = rowIndex + 2
      return `<row r="${line}">${columns.map((column, index) => dwXlsxCell(`${dwColumnName(index)}${line}`, row[index], numeric[index])).join('')}</row>`
    }),
  ]
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows.join('')}</sheetData></worksheet>`
  return dwZipStore([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Result" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ])
}

/**
 * Ask the user where to save, then write there.
 *
 * @returns `{ via: 'picker' | 'download', name }` or `{ cancelled: true }`
 */
export async function dwSaveFile(options) {
  const picker = globalThis.showSaveFilePicker
  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName: options.name,
        types: [{ description: options.description, accept: { [options.mime]: [options.extension] } }],
      })
      const writable = await handle.createWritable()
      await writable.write(options.data)
      await writable.close()
      return { via: 'picker', name: handle.name ?? options.name }
    } catch (error) {
      if (error?.name === 'AbortError') return { cancelled: true }
      // A host that exposes the picker but refuses it (permissions, Electron build)
      // still gets the file through the download path below.
    }
  }
  const blob = new Blob([options.data], { type: options.mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = options.name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
  return { via: 'download', name: options.name }
}
