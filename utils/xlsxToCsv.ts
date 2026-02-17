import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

/**
 * Convert an XLSX buffer to CSV (first sheet) using python3 + openpyxl.
 * Security posture: we avoid Node xlsx (SheetJS) due to known vuln advisories.
 */
export async function xlsxBufferToCsv(buffer: Buffer): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-xlsx-'));
  const inPath = path.join(dir, 'input.xlsx');
  const outPath = path.join(dir, 'output.csv');
  fs.writeFileSync(inPath, buffer);

  const py = `
import csv
from openpyxl import load_workbook

in_path = r'''${inPath.replace(/\\/g, '\\\\')}'''
out_path = r'''${outPath.replace(/\\/g, '\\\\')}'''

wb = load_workbook(filename=in_path, read_only=True, data_only=True)
ws = wb[wb.sheetnames[0]]

with open(out_path, 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f)
    for row in ws.iter_rows(values_only=True):
        # Convert everything to strings (or empty) to avoid Excel type coercion surprises downstream.
        w.writerow(['' if v is None else str(v) for v in row])
`;

  await new Promise<void>((resolve, reject) => {
    execFile('python3', ['-c', py], { timeout: 60_000 }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  const csvBuf = fs.readFileSync(outPath);

  // Best-effort cleanup
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

  return csvBuf;
}
