// A simple Node.js script for basic architectural audit.

const fs = require('fs');
const path = require('path');

const projectRoot = process.cwd();

function readArchitecturalRules() {
    try {
        const rulesPath = path.join(projectRoot, '.agent', 'rules', 'architecture-design.md');
        console.log(`- Reading architectural rules from: ${rulesPath}`);
        const rulesContent = fs.readFileSync(rulesPath, 'utf8');
        // In a real script, you would parse this file to extract rules dynamically.
        // For this example, we just confirm the file is readable and use hardcoded rules below.
        console.log('- Rules file loaded successfully. Using sample rule: "Controller layer should not directly access data layer."\n');
        return rulesContent;
    } catch (error) {
        console.error('❌ Cannot read .agent/rules/architecture-design.md. Please ensure the file exists.');
        process.exit(1);
    }
}

function findSourceFiles(dir, filelist = []) {
    try {
        const files = fs.readdirSync(dir);
        files.forEach(file => {
            const filepath = path.join(dir, file);
            if (fs.statSync(filepath).isDirectory()) {
                // Ignore common large or irrelevant directories
                if (file !== 'node_modules' && file !== '.git' && file !== '.agent') {
                    filelist = findSourceFiles(filepath, filelist);
                }
            } else {
                // In this example, we only check JavaScript files
                if (path.extname(file) === '.js') {
                    filelist.push(filepath);
                }
            }
        });
    } catch (error) {
        // Ignore permission errors or other issues when reading directories
    }
    return filelist;
}

function auditFiles(files) {
    console.log(`- Auditing ${files.length} source files...`);
    const violations = [];

    // Sample rule: files in 'controllers' directory should not import 'db' module.
    const hypotheticalControllerDir = 'controllers';
    const dataLayerImportPattern = /require\(['"]db['"]\)|import .* from ['"]db['"]/g;

    files.forEach(file => {
        // This is a minimal check using regular expressions.
        // A real audit tool would use Abstract Syntax Trees (AST) for accuracy.
        if (file.includes(path.sep + hypotheticalControllerDir + path.sep)) {
            const content = fs.readFileSync(file, 'utf8');
            if (dataLayerImportPattern.test(content)) {
                violations.push(`Violation in ${file}: Controller layer appears to directly import data layer.`);
            }
        }
    });
    return violations;
}

function run() {
    console.log('--- 🛡️  Starting Architecture Guard Audit ---');
    readArchitecturalRules();
    const allSourceFiles = findSourceFiles(projectRoot);
    const violations = auditFiles(allSourceFiles);

    console.log('\n--- 📝 Audit Report ---');
    if (violations.length === 0) {
        console.log('✅ No architectural violations found based on current simplified rules.');
    } else {
        console.log(`🚨 Found ${violations.length} potential violation(s):`);
        violations.forEach(v => console.log(`- ${v}`));
    }
    console.log('--------------------');
}

run();
