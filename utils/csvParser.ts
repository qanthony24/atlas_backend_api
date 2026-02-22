import { Readable } from 'stream';
import csv from 'csv-parser';

// Clean Louisiana voter file headers.
// Louisiana exports can include commas inside the header label (e.g. "RESIDENTIAL ADDRESS, LINE 1").
// Requirement: split on FIRST comma, then normalize.
export const cleanLouisianaHeader = (header: string): string => {
  const raw = String(header ?? '');
  const first = raw.split(',', 1)[0];
  return first.replace(/"/g, '').trim().toUpperCase();
};

// Parse a CSV line, handling quoted fields and commas inside quotes
export const parseCSVLine = (line: string): string[] => {
  const stream = Readable.from(line);
  const parser = csv({ headers: false, quote: '"', escape: '"', skipEmptyLines: true });
  let row: string[] = [];
  parser.on('data', (data) => row = Object.values(data));
  parser.write(line);
  parser.end();
  return row;
};