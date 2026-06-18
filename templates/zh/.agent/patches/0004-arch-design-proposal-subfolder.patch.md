---
id: 0004-arch-design-proposal-subfolder
target: workflows/arch-design.md
anchor: "禁止将提案直接放在"
insert_after: "- **编写提案**: 提供清晰的设计说明，建议包含："
---
- **确定提案路径**：在写文件前，先从提案主题推导出所属分类（topic），按以下规则保存：
  ```
  .agent/plans/proposals/<topic>/<简短名称>-proposal.md
  ```
  - `topic` 取提案的核心模块或业务域，使用 kebab-case（如 `auth`、`device-template`、`state-management`）
  - 若同主题下已有子文件夹，直接复用；若无，创建新文件夹
  - **禁止将提案直接放在 `.agent/plans/proposals/` 根目录下**

