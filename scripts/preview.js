const fs = require('fs');
const path = require('path');

// Extract the renderAdminUI string from admin.ts using simple string manipulation
const adminTsPath = path.join(__dirname, '../src/handlers/admin.ts');
const adminTs = fs.readFileSync(adminTsPath, 'utf8');

// Identify template boundaries
const startIndex = adminTs.indexOf('<!DOCTYPE html>');
const endIndex = adminTs.lastIndexOf('</html>');

if (startIndex === -1 || endIndex === -1) {
  console.error("Could not find HTML template boundaries in admin.ts");
  process.exit(1);
}

// Extract the template string content
let htmlContent = adminTs.slice(startIndex, endIndex + 7);

// Replace template variables with mock data for preview purposes
htmlContent = htmlContent.replace(/\$\{hostname\}/g, 'preview.local');
htmlContent = htmlContent.replace(/\$\{token\}/g, 'MOCK_TOKEN_FOR_PREVIEW');

// Unescape JavaScript syntax that was escaped for the TypeScript template literal
htmlContent = htmlContent.replace(/\\`/g, '`');
htmlContent = htmlContent.replace(/\\\$\{/g, '${');

const outputPath = path.join(__dirname, '../preview.html');
fs.writeFileSync(outputPath, htmlContent, 'utf8');

console.log(`\x1b[32mSuccessfully generated preview.html\x1b[0m`);
console.log(`Open file://${outputPath} in your browser to preview the UI.`);
