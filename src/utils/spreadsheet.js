import readXlsxFile from 'read-excel-file/browser'

const XLSX_EXTS = ['xlsx', 'xls', 'xlsm']

/**
 * Read a CSV or Excel file and return a CSV-formatted string.
 * The first sheet is used for Excel files.
 *
 * @param {File} file
 * @returns {Promise<{ text: string, sheetName?: string, sheetCount?: number }>}
 */
export async function readSpreadsheet(file) {
  const ext = file.name.toLowerCase().split('.').pop()

  if (ext === 'csv' || file.type === 'text/csv') {
    return { text: await file.text() }
  }

  if (XLSX_EXTS.includes(ext)) {
    // read-excel-file v9: readXlsxFile(file) returns Row[][] for the first
    // sheet. To handle multi-sheet workbooks we first list the sheet names
    // with { getSheets: true }, then read each sheet by name.
    let sheetList
    try {
      sheetList = await readXlsxFile(file, { getSheets: true })
    } catch {
      sheetList = null
    }

    if (!sheetList || !sheetList.length) {
      // Single-sheet fallback — just read the default (first) sheet.
      const rows = await readXlsxFile(file)
      if (!rows || !rows.length) throw new Error('Excel file is empty or has no rows.')
      const text = rowsToCSV(rows)
      return { text, sheetName: undefined, sheetCount: 1, sheets: [{ name: file.name, text }] }
    }

    const sheets = []
    for (const s of sheetList) {
      const name = s && s.name ? s.name : String(s)
      const rows = await readXlsxFile(file, { sheet: name })
      sheets.push({ name, text: rowsToCSV(rows || []) })
    }
    return {
      text: sheets[0].text,
      sheetName: sheets[0].name,
      sheetCount: sheets.length,
      sheets,
    }
  }

  throw new Error(`Unsupported file type: .${ext}. Use .csv, .xlsx, .xls, or .xlsm.`)
}

function rowsToCSV(rows) {
  return rows.map((row) => row.map(cellToCSV).join(',')).join('\n')
}

function cellToCSV(cell) {
  if (cell == null) return ''
  if (cell instanceof Date) return cell.toISOString().slice(0, 10)
  const s = String(cell)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}
