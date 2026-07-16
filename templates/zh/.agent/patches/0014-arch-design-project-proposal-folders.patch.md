---
id: 0014-arch-design-project-proposal-folders
target: workflows/arch-design.md
anchor: "项目级提案组"
insert_after: "- **编写提案**: 提供清晰的设计说明，建议包含："
---
- **项目级提案目录**：创建提案前读取 `.agent/rules/proposal-structure.md`，并判断提案属于单点提案还是项目级提案组。

  单点提案继续使用：
  ```text
  .agent/plans/proposals/<topic>/<简短名称>-proposal.md
  ```

  大项目、关联项目、跨多个 workflow/skill/CLI 能力、跨多个实战项目验证，或需要多个子提案时，必须使用项目文件夹：
  ```text
  .agent/plans/proposals/projects/<project-slug>/
    index.md
    proposals/P-001-<简短名称>-proposal.md
    decisions/
    references.md
    relations.md
  ```
  - 使用 `.agent/resources/templates/proposal-project-index.md` 创建或更新 `index.md`
  - 在 `relations.md` 记录关联项目、上下游依赖、同步范围和验证状态
  - 禁止将提案直接放在 `.agent/plans/proposals/` 根目录
  - 禁止提交 `.DS_Store`、临时文件或导出缓存
