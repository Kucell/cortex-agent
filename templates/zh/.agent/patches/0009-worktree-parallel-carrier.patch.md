---
id: 0009-worktree-parallel-carrier
target: workflows/parallel.md
anchor: ".agent/rules/worktree-collaboration.md"
---

---

## Worktree 并行载体补充

当同批任务需要真实并行开发时，先读取 `.agent/rules/worktree-collaboration.md`，判断是否为每个任务创建独立 worktree。

- 适合：不同模块/目录、独立验证、需要独立 dev server 或运行状态
- 不适合：共享同一契约、公共类型、迁移文件、独占设备或远程环境
- 每个 worktree 完成可验证任务后及时 `/ship` 或 `/commit`
- 合并后必须在目标主线 worktree 重新验证功能
