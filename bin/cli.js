#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const templateDir = path.join(__dirname, '../templates');

function copyRecursive(src, dest) {
    const exists = fs.existsSync(src);
    const stats = exists && fs.statSync(src);
    const isDirectory = exists && stats.isDirectory();
    if (isDirectory) {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest);
        fs.readdirSync(src).forEach((child) => {
            copyRecursive(path.join(src, child), path.join(dest, child));
        });
    } else {
        fs.copyFileSync(src, dest);
    }
}

function init() {
    console.log('🧠 Initializing Cortex Agent Framework...');

    // 1. Copy .agent folder (Knowledge Base)
    const agentSrc = path.join(templateDir, '.agent');
    const agentDest = path.join(cwd, '.agent');

    if (fs.existsSync(agentDest)) {
        console.warn('⚠️  .agent directory already exists. Skipping...');
    } else {
        copyRecursive(agentSrc, agentDest);
        console.log('✅ Created .agent directory (Knowledge Base).');
    }

    // 2. Copy .cursor folder (Triggers & Proxy Rules)
    const cursorSrc = path.join(templateDir, '.cursor');
    const cursorDest = path.join(cwd, '.cursor');

    if (fs.existsSync(cursorDest)) {
        console.warn('⚠️  .cursor directory already exists. Merging/Skipping...');
    } else {
        copyRecursive(cursorSrc, cursorDest);
        console.log('✅ Created .cursor directory (Native Rules, Skills, Commands).');
    }

    // 2. Integration prompts/copies
    const integrations = [
        { name: 'Cursor', file: '.cursorrules', srcPath: 'cursor/.cursorrules' },
        { name: 'Claude Code', file: '.clauderules', srcPath: 'claude/.clauderules' },
        { name: 'Windsurf', file: '.windsurfrules', srcPath: 'windsurf/.windsurfrules' },
        { name: 'Aider', file: '.aider.instructions.md', srcPath: 'aider/.aider.instructions.md' },
        { name: 'GitHub Copilot', file: '.github/copilot-instructions.md', srcPath: 'copilot/.github/copilot-instructions.md' },
        { name: 'Continue', file: '.continuerules', srcPath: 'continue/.continuerules' }
    ];

    console.log('\n🤖 Setting up agent integrations...');

    integrations.forEach(integration => {
        const src = path.join(templateDir, 'integrations', integration.srcPath);
        const dest = path.join(cwd, integration.file);
        const destDir = path.dirname(dest);

        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }

        if (fs.existsSync(dest)) {
            console.log(`ℹ️  ${integration.file} already exists for ${integration.name}.`);
        } else {
            fs.copyFileSync(src, dest);
            console.log(`✅ Added ${integration.file} for ${integration.name}.`);
        }
    });

    console.log('\n🎉 Cortex Agent initialized successfully!');
    console.log('👉 Next steps:');
    console.log('   1. Edit .agent/rules/tech-stack.md');
    console.log('   2. Edit .agent/rules/architecture-design.md');
    console.log('   3. Update .agent/plans/task-progress.md');
}

const command = process.argv[2];

if (command === 'init') {
    init();
} else {
    console.log('Usage: npx cortex-agent init');
}
