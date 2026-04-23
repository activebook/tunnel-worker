/**
 * preview.ts
 *
 * Extracts the HTML template from admin.ts, replaces template variables with
 * mock data, and writes a standalone preview.html for local UI inspection.
 *
 * Usage: npx tsx scripts/preview.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const adminTsPath = join(process.cwd(), 'src/handlers/admin.ts');
const adminTs = readFileSync(adminTsPath, 'utf8');

const startIndex = adminTs.indexOf('<!DOCTYPE html>');
const endIndex = adminTs.lastIndexOf('</html>');

if (startIndex === -1 || endIndex === -1) {
  console.error('Could not find HTML template boundaries in admin.ts');
  process.exit(1);
}

let htmlContent = adminTs.slice(startIndex, endIndex + 7);

// Replace template variables with mock data for preview purposes
htmlContent = htmlContent
  .replace(/\$\{hostname\}/g, 'preview.local')
  .replace(/\$\{token\}/g, 'MOCK_TOKEN_FOR_PREVIEW');

// Unescape JavaScript syntax that was escaped for the TypeScript template literal
htmlContent = htmlContent.replace(/\\`/g, '`').replace(/\\\$\{/g, '${');

const outputPath = join(process.cwd(), 'preview.html');
writeFileSync(outputPath, htmlContent, 'utf8');

console.log('\x1b[32mSuccessfully generated preview.html\x1b[0m');
console.log(`Open file://${outputPath} in your browser to preview the UI.`);
