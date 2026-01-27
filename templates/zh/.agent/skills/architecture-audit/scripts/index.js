// 一个简单的 Node.js 脚本，用于执行基本的架构审计。

const fs = require('fs');
const path = require('path');

const projectRoot = process.cwd();

function readArchitecturalRules() {
    try {
        const rulesPath = path.join(projectRoot, '.agent', 'rules', 'architecture-design.md');
        console.log(`- 正在读取架构规则文件: ${rulesPath}`);
        const rulesContent = fs.readFileSync(rulesPath, 'utf8');
        // 在真实的脚本中，您会解析这个文件来动态提取规则。
        // 在本示例中，我们只确认文件可读，并在后续使用硬编码的规则。
        console.log('- 规则文件读取成功。使用示例规则进行审计: "控制器层不应直接访问数据层。"\n');
        return rulesContent;
    } catch (error) {
        console.error('❌ 无法读取 .agent/rules/architecture-design.md。请确保文件存在。');
        process.exit(1);
    }
}

function findSourceFiles(dir, filelist = []) {
    try {
        const files = fs.readdirSync(dir);
        files.forEach(file => {
            const filepath = path.join(dir, file);
            if (fs.statSync(filepath).isDirectory()) {
                // 忽略常见的、体积大的或不相关的目录
                if (file !== 'node_modules' && file !== '.git' && file !== '.agent') {
                    filelist = findSourceFiles(filepath, filelist);
                }
            } else {
                // 在本示例中，我们只检查 JavaScript 文件
                if (path.extname(file) === '.js') {
                    filelist.push(filepath);
                }
            }
        });
    } catch (error) {
        // 忽略读取目录时可能出现的权限错误或其他问题
    }
    return filelist;
}

function auditFiles(files) {
    console.log(`- 正在审计 ${files.length} 个源文件...`);
    const violations = [];
    
    // 示例规则: 'controllers' 目录下的文件不应导入 'db' 模块。
    const hypotheticalControllerDir = 'controllers'; 
    const dataLayerImportPattern = /require\(['"]db['"]\)|import .* from ['"]db['"]/g;

    files.forEach(file => {
        // 这是一个使用正则表达式的极简检查。
        // 一个真实的审计工具会使用抽象语法树 (AST) 来保证准确性。
        if (file.includes(path.sep + hypotheticalControllerDir + path.sep)) {
            const content = fs.readFileSync(file, 'utf8');
            if (dataLayerImportPattern.test(content)) {
                violations.push(`违规文件 ${file}: 控制器层似乎直接导入了数据层。`);
            }
        }
    });
    return violations;
}

function run() {
    console.log('--- 🏛️  开始架构审计 ---');
    readArchitecturalRules();
    const allSourceFiles = findSourceFiles(projectRoot);
    const violations = auditFiles(allSourceFiles);

    console.log('\n--- 📝 审计报告 ---');
    if (violations.length === 0) {
        console.log('✅ 基于当前的简化规则，未发现架构违规。');
    } else {
        console.log(`🚨 发现 ${violations.length} 个潜在的违规项:`);
        violations.forEach(v => console.log(`- ${v}`));
    }
    console.log('--------------------');
}

run();
