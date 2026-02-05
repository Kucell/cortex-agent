#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");

const cwd = process.cwd();
const args = process.argv.slice(2);
const command = args[0];

// Basic argument parsing
const options = {};
for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--lang" || arg === "-l") {
        options.lang = args[i + 1];
    } else if (arg && arg.startsWith("--lang=")) {
        options.lang = arg.split("=")[1];
    }
    if (arg === "--global" || arg === "-g") {
        options.global = true;
    }
}

// Default language detection
const defaultLang =
    process.env.LANG && process.env.LANG.startsWith("zh") ? "zh" : "en";
const lang = options.lang || defaultLang;

const baseTemplateDir = path.join(__dirname, "../templates");
const templateDir = path.join(baseTemplateDir, lang);


// List of legacy config files to check for migration
const legacyConfigFiles = [
    ".cursorrules",
    ".clauderules",
    "CLAUDE.md",
    ".windsurfrules",
    ".aider.instructions.md",
    ".continuerules",
    ".github/copilot-instructions.md",
];

function copyRecursive(src, dest) {
    if (!fs.existsSync(src)) return;
    const stats = fs.statSync(src);
    const isDirectory = stats.isDirectory();
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
    console.log("🔍 Checking for existing AI assistant configurations...");
    let foundLegacyConfig = false;
    const importedRulesDir = path.join(cwd, ".agent", "imported_rules");

    legacyConfigFiles.forEach((fileName) => {
        const filePath = path.join(cwd, fileName);
        if (fs.existsSync(filePath)) {
            if (!foundLegacyConfig) {
                console.log(
                    "Legacy configurations found. Migrating them to .agent/imported_rules/",
                );
                foundLegacyConfig = true;
                if (!fs.existsSync(importedRulesDir)) {
                    fs.mkdirSync(importedRulesDir, { recursive: true });
                }
            }
            const destFileName = `imported_from_${path.basename(fileName)}.md`;
            const destPath = path.join(importedRulesDir, destFileName);
            const content = fs.readFileSync(filePath, "utf8");
            fs.writeFileSync(destPath, `# Imported from ${fileName}\n\n${content}`);
            console.log(`  - Migrated ${fileName}`);
        }
    });

    if (!foundLegacyConfig) {
        console.log("No legacy configurations found.");
    }

    return foundLegacyConfig;
}

function init() {
    console.log(`🧠 Initializing Cortex Agent Framework...`);
    console.log(`🌍 Using template language: ${lang}`);

    if (!fs.existsSync(templateDir)) {
        console.error(
            `❌ Error: Template directory for language '${lang}' not found at ${templateDir}`,
        );
        process.exit(1);
    }

    const isExistingProject = migrateOldConfigs();


    // 1. Copy .agent folder (Knowledge Base)
    const agentSrc = path.join(templateDir, ".agent");
    const targetBase = options.global ? os.homedir() : cwd;
    const agentDest = path.join(targetBase, ".agent");

    if (fs.existsSync(agentDest) && !isExistingProject) {
        console.warn(
            `⚠️  ${agentDest} directory already exists. Skipping creation of knowledge base.`,
        );
    } else {
        if (fs.existsSync(agentSrc)) {
            copyRecursive(agentSrc, agentDest);
            console.log(`✅ Created ${agentDest} directory (Knowledge Base).`);
        } else {
            console.warn(
                `⚠️  Knowledge base template not found at ${agentSrc}. Skipping.`,
            );
        }
    }

    // Skip integrations and links in global mode
    if (options.global) {
        console.log("\n🎉 Global Cortex Agent initialized successfully!");
        return;
    }

    // 2. Integration prompts/copies
    const integrations = [
        { name: "Cursor", file: ".cursorrules", srcPath: "cursor/.cursorrules" },
        {
            name: "Claude Code",
            file: ".clauderules",
            srcPath: "claude/.clauderules",
        },
        {
            name: "Windsurf",
            file: ".windsurfrules",
            srcPath: "windsurf/.windsurfrules",
        },
        {
            name: "Aider",
            file: ".aider.instructions.md",
            srcPath: "aider/.aider.instructions.md",
        },
        {
            name: "GitHub Copilot",
            file: ".github/copilot-instructions.md",
            srcPath: "copilot/.github/copilot-instructions.md",
        },
        {
            name: "Continue",
            file: ".continuerules",
            srcPath: "continue/.continuerules",
        },
    ];

    console.log("\n🤖 Setting up agent integrations...");

    integrations.forEach((integration) => {
        const src = path.join(templateDir, "integrations", integration.srcPath);
        const dest = path.join(cwd, integration.file);
        const destDir = path.dirname(dest);

        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }

        if (fs.existsSync(dest)) {
            console.log(
                `ℹ️  ${integration.file} already exists for ${integration.name}.`,
            );

        } else {
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, dest);
                console.log(`✅ Added ${integration.file} for ${integration.name}.`);
            } else {
                console.log(
                    `ℹ️  Integration file for ${integration.name} not available in ${lang}. Skipping.`,
                );
            }
        }
    });

    setupPlatformLinks();
    linkGlobalConfig();

    console.log("\n🎉 Cortex Agent initialized successfully!");

    if (isExistingProject) {
        console.log("\n👉 Your existing project is ready for migration!");
        console.log(
            "   We've imported your old configurations into `.agent/imported_rules/`.",
        );
        console.log(
            "   To complete the process, run the `/migrate-rules` command in your AI assistant for a guided migration.",
        );
    } else {
        console.log("\n👉 Your new project is ready! What's next?");
        console.log(
            "   Run the `/configure` command in your AI assistant to interactively set up your agent.",
        );
    }
}

function setupPlatformLinks() {
    console.log("\n🔗 Automating platform mappings via symbolic links...");

    const links = [
        // For Cursor
        { target: "../.agent/workflows", link: ".cursor/commands" },
        { target: "../.agent/rules", link: ".cursor/rules" },
        { target: "../.agent/skills", link: ".cursor/skills" },
        { target: ".agent/rules/core-principles.md", link: ".cursorrules" },

        // For Claude
        { target: "../.agent/workflows", link: ".claude/commands" },
        { target: "../.agent/sub-agents", link: ".claude/agents" },
        { target: "../.agent/plugins", link: ".claude/plugins" },
        { target: ".agent/rules/core-principles.md", link: "CLAUDE.md" },

        // For Windsurf
        { target: "../.agent/workflows", link: ".windsurf/workflows" },
        { target: "../.agent/rules", link: ".windsurf/rules" },
    ];

    links.forEach((item) => {
        const linkPath = path.join(cwd, item.link);
        const linkDir = path.dirname(linkPath);

        if (!fs.existsSync(linkDir)) {
            fs.mkdirSync(linkDir, { recursive: true });
        }

        if (fs.existsSync(linkPath)) {
            console.log(
                `ℹ️  Path ${item.link} already exists. Skipping link creation.`,
            );
        } else {
            try {
                fs.symlinkSync(item.target, linkPath);
                console.log(`✅ Linked ${item.link} -> ${item.target}`);
            } catch (err) {
                console.warn(`⚠️  Failed to link ${item.link}: ${err.message}`);
            }
        }
    });
}

function linkGlobalConfig() {
    const globalAgentPath = path.join(os.homedir(), ".agent");
    if (!fs.existsSync(globalAgentPath)) return;

    console.log("\n🌍 Detecting global configuration at ~/.agent...");

    // Create a symlink inside .agent/ to point to the global one
    const globalLinkInAgent = path.join(cwd, ".agent", "global");
    if (!fs.existsSync(globalLinkInAgent)) {
        try {
            // We use absolute path for the global link target
            fs.symlinkSync(globalAgentPath, globalLinkInAgent);
            console.log(`✅ Linked .agent/global -> ~/.agent`);
        } catch (err) {
            console.warn(
                `⚠️  Failed to create global link in .agent: ${err.message}`,
            );
        }
    }

    // Platform specific global links
    const globalLinks = [
        { target: globalAgentPath + "/rules", link: ".cursor/global-rules" },
        { target: globalAgentPath + "/workflows", link: ".cursor/global-commands" },
        { target: globalAgentPath + "/workflows", link: ".claude/global-commands" },
    ];

    globalLinks.forEach((item) => {
        const linkPath = path.join(cwd, item.link);
        const linkDir = path.dirname(linkPath);

        if (!fs.existsSync(linkDir)) {
            fs.mkdirSync(linkDir, { recursive: true });
        }

        if (!fs.existsSync(linkPath)) {
            try {
                fs.symlinkSync(item.target, linkPath);
                console.log(`✅ Linked ${item.link} -> ${item.target} (Global)`);
            } catch (err) {
                console.warn(`⚠️  Failed to link global ${item.link}: ${err.message}`);
            }
        }
    });
}

if (command === "init") {
    init();
} else if (command === "link-global") {
    linkGlobalConfig();
} else {
    console.log("Usage: npx cortex-agent init [--lang en|zh] [--global|-g]");
    console.log("       npx cortex-agent link-global");
}
