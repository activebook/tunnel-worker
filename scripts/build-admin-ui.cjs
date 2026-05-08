const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

async function buildAdminUI() {
    console.log('🎨 Compiling admin UI...');
    
    const uiDir = path.join(__dirname, '../src/ui/admin');
    const htmlPath = path.join(uiDir, 'admin.html');
    const cssPath = path.join(uiDir, 'admin.css');
    const jsPath = path.join(uiDir, 'admin.js');
    const outPath = path.join(uiDir, 'admin.generated.ts');

    let html = fs.readFileSync(htmlPath, 'utf8');
    const css = fs.readFileSync(cssPath, 'utf8');
    const js = fs.readFileSync(jsPath, 'utf8');

    // Minify CSS
    const cssResult = await esbuild.transform(css, {
        loader: 'css',
        minify: true,
    });

    // Minify JS
    const jsResult = await esbuild.transform(js, {
        loader: 'js',
        minify: true,
        target: 'es2020',
        sourcemap: 'inline', // Helpful for debugging
    });

    // Read version from package.json
    const pkgPath = path.join(__dirname, '../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    
    // Inject CSS, JS, and Version into HTML
    html = html.replace('{{CSS}}', cssResult.code.trim());
    html = html.replace('{{JS}}', jsResult.code.trim());
    html = html.replace('{{APP_VERSION}}', pkg.version);

    // Escape backticks and ${} to embed cleanly inside a TypeScript template string
    // Wait, since we are exporting as a template literal string, we only need to escape ` and ${
    const escapedHtml = html
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$\{/g, '\\${');

    const generatedTs = `// THIS FILE IS AUTO-GENERATED. DO NOT EDIT DIRECTLY.
export const ADMIN_TEMPLATE = \`${escapedHtml}\`;
`;

    fs.writeFileSync(outPath, generatedTs);
    console.log(`✅ Admin UI compiled successfully: ${outPath}`);
}

module.exports = { buildAdminUI };
