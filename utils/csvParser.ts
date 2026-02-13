import { Readable } from 'stream';
import csv from 'csv-parser';

// Clean Louisiana voter file headers (e.g., remove quotes, normalize)
export const cleanLouisianaHeader = (header: string): string => {
  return header.replace(/"/g, '').trim().toUpperCase();
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