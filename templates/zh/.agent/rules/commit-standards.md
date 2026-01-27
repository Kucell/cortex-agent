# Git 提交规范 (模板)

## 提交准则
1. **原子提交**: 每次提交应仅包含一个逻辑改动。
2. **规范化消息**: 建议遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范。
3. **范围限定**: `scope` 应反映受影响的模块或目录（如 `core`, `ui`, `api`）。

## 消息格式说明
格式: `<type>(<scope>): <subject>`

### 常用类型 (Type)
- `feat`: 新功能 (feature)
- `fix`: 修复 Bug (bug fix)
- `docs`: 仅文档更新 (documentation)
- `style`: 代码格式变动 (不影响逻辑的变动，如空格、格式化等)
- `refactor`: 重构 (既不是修复 bug 也不是添加新功能的代码变动)
- `perf`: 提高性能的代码变动 (performance)
- `test`: 添加缺失的测试或更正现有的测试 (test)
- `chore`: 对构建过程或辅助工具和库（如文档生成）的变动

### 语言规范
- `subject`: 建议使用清晰简洁的描述（根据项目偏好选择中文或英文）。
- `body`: 对于复杂的变动，应在正文中详细列出改动内容和动机。

## 提交前自检
- 是否运行了格式化工具（如 Prettier）？
- 是否运行了类型检查（如 TypeScript）？
- 是否运行了相关的单元测试并全部通过？
