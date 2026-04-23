const esbuild = require('esbuild');
const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

async function build() {
    const entryPoint = path.join(__dirname, '../src/worker.ts');
    const outDir = path.join(__dirname, '../dist');
    const outFile = path.join(outDir, 'index.js');

    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir);
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    console.log(`📦 Bundling version ${pkg.version} with esbuild...`);

    // 1. Bundle TypeScript into a single monolithic JS file
    try {
        await esbuild.build({
            entryPoints: [entryPoint],
            bundle: true,
            outfile: outFile,
            format: 'esm',
            target: 'es2022',
            minify: false,
            sourcemap: false,
            platform: 'browser',
            external: ['cloudflare:*'],
            define: {
                'process.env.NODE_ENV': '"production"',
                '__APP_VERSION__': `"${pkg.version}"`,
            },
        });

    } catch (err) {
        console.error('❌ esbuild failure:', err);
        process.exit(1);
    }

    console.log('🛡️  Applying advanced obfuscation...');

    // 2. Read the bundled code
    const rawCode = fs.readFileSync(outFile, 'utf8');

    // 3. Obfuscate the code
    const obfuscatedResult = JavaScriptObfuscator.obfuscate(rawCode, {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.75,
        deadCodeInjection: false,
        debugProtection: false, // Can break Cloudflare environment if it tries to use eval/timers
        disableConsoleOutput: true,
        identifierNamesGenerator: 'mangled',
        log: false,
        numbersToExpressions: true,
        renameGlobals: false, // Prevents breaking global Cloudflare scopes
        rotateStringArray: true,
        selfDefending: false, // Often conflicts with Worker's restricted environment
        stringArray: true,
        stringArrayCallsTransform: true,
        stringArrayCallsTransformThreshold: 0.75,
        stringArrayEncoding: ['base64', 'rc4'],
        stringArrayIndexesType: ['hexadecimal-number'],
        stringArrayThreshold: 0.75,
        transformObjectKeys: false, // CRITICAL: Must be false so it doesn't mangle 'fetch' in 'export default { fetch }'
        unicodeEscapeSequence: true,
        target: 'browser'
    });

    // 4. Write back the obfuscated code
    let finalCode = obfuscatedResult.getObfuscatedCode();

    // Cloudflare Workers strictly disable eval() and new Function().
    // javascript-obfuscator's string array wrapper attempts to use those to find the global context,
    // catches the resulting exception, and falls back to checking `window` or `global`.
    // Since neither exists in the V8 isolate by default, it throws a ReferenceError.
    // Prepending this polyfill safely resolves the environment discrepancy.
    finalCode = 'globalThis.window = globalThis;\n' + finalCode;

    fs.writeFileSync(outFile, finalCode);

    // 5. Generate a standalone wrangler.toml for the distribution package
    const rootWranglerPath = path.join(__dirname, '../wrangler.toml');
    const distWranglerPath = path.join(outDir, 'wrangler.toml');
    if (fs.existsSync(rootWranglerPath)) {
        let tomlContent = fs.readFileSync(rootWranglerPath, 'utf8');
        // Rewrite the entry point to point to the local index.js instead of dist/index.js
        tomlContent = tomlContent.replace(/main\s*=\s*["']dist\/index\.js["']/, 'main = "index.js"');

        // Strip all comments (lines starting with # or inline #) and condense empty lines
        tomlContent = tomlContent.replace(/#.*$/gm, '').replace(/^\s*[\r\n]/gm, '');

        fs.writeFileSync(distWranglerPath, tomlContent);
        console.log('📄 Generated standalone and minified dist/wrangler.toml');
    }

    console.log('✅ Build complete. The dist/ folder is now a fully self-contained deployment package.');
}

build();
