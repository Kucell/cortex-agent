#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const templateDir = path.join(__dirname, '../templates');

// List of legacy config files to check for migration
const legacyConfigFiles = [
    '.cursorrules',
    '.clauderules',
    'CLAUDE.md',
    '.windsurfrules',
    '.aider.instructions.md',
    '.continuerules',
    '.github/copilot-instructions.md'
];

function copyRecursive(src, dest) {
    const exists = fs.existsSync(src);
    const stats = exists && fs.statSync(src);
    const isDirectory = exists && stats.isDirectory();
    if (isDirectory) {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        fs.readdirSync(src).forEach((child) => {
            copyRecursive(path.join(src, child), path.join(dest, child));
        });
    } else {
        fs.copyFileSync(src, dest);
    }
}

function migrateOldConfigs() {
    console.log('🔍 Checking for existing AI assistant configurations...');
    let foundLegacyConfig = false;
    const importedRulesDir = path.join(cwd, '.agent', 'imported_rules');

    legacyConfigFiles.forEach(fileName => {
        const filePath = path.join(cwd, fileName);
        if (fs.existsSync(filePath)) {
            if (!foundLegacyConfig) {
                console.log('Legacy configurations found. Migrating them to .agent/imported_rules/');
                foundLegacyConfig = true;
                if (!fs.existsSync(importedRulesDir)) {
                    fs.mkdirSync(importedRulesDir, { recursive: true });
                }
            }
            const destFileName = `imported_from_${path.basename(fileName)}.md`;
            const destPath = path.join(importedRulesDir, destFileName);
            const content = fs.readFileSync(filePath, 'utf8');
            fs.writeFileSync(destPath, `# Imported from ${fileName}\n\n${content}`);
            console.log(`  - Migrated ${fileName}`);
        }
    });

    if (!foundLegacyConfig) {
        console.log('No legacy configurations found.');
    }

    return foundLegacyConfig;
}


function init() {
    console.log('🧠 Initializing Cortex Agent Framework...');
    
    const isExistingProject = migrateOldConfigs();

    // 1. Copy .agent folder (Knowledge Base)
    const agentSrc = path.join(templateDir, '.agent');
    const agentDest = path.join(cwd, '.agent');

    if (fs.existsSync(agentDest) && !isExistingProject) {
        console.warn('⚠️  .agent directory already exists. Skipping creation of knowledge base.');
    } else {
        copyRecursive(agentSrc, agentDest);
        console.log('✅ Created .agent directory (Knowledge Base).');
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

    setupPlatformLinks();

    console.log('\n🎉 Cortex Agent initialized successfully!');
    
    if (isExistingProject) {
        console.log('\n👉 Your existing project is ready for migration!');
        console.log('   We\'ve imported your old configurations into `.agent/imported_rules/`.');
        console.log('   To complete the process, run the `/migrate-rules` command in your AI assistant for a guided migration.');
    } else {
        console.log('\n👉 Your new project is ready! What\'s next?');
        console.log('   Run the `/configure` command in your AI assistant to interactively set up your agent.');
    }
}

function setupPlatformLinks() {
    console.log('\n🔗 Automating platform mappings via symbolic links...');

    const links = [
        // For Cursor
        { target: '../.agent/workflows', link: '.cursor/commands' },
        { target: '../.agent/rules', link: '.cursor/rules' },
        { target: '../.agent/skills', link: '.cursor/skills' },

        // For Claude
        { target: '../.agent/workflows', link: '.claude/commands' },
        { target: '../.agent/sub-agents', link: '.claude/agents' },
        { target: '../.agent/plugins', link: '.claude/plugins' },
        { target: '.agent/rules/core-principles.md', link: 'CLAUDE.md' },

        // For Windsurf
        { target: '../.agent/workflows', link: '.windsurf/workflows' },
        { target: '../.agent/rules', link: '.windsurf/rules' }
    ];

    links.forEach(item => {
        const linkPath = path.join(cwd, item.link);
        const linkDir = path.dirname(linkPath);

        if (!fs.existsSync(linkDir)) {
            fs.mkdirSync(linkDir, { recursive: true });
        }

        if (fs.existsSync(linkPath)) {
            console.log(`ℹ️  Path ${item.link} already exists. Skipping link creation.`);
        } else {
            fs.symlinkSync(item.target, linkPath);
            console.log(`✅ Linked ${item.link} -> ${item.target}`);
        }
    });
}

const command = process.argv[2];

if (command === 'init') {
    init();
} else {
    console.log('Usage: npx cortex-agent init');
}
