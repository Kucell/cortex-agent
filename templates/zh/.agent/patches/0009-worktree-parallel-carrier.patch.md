---
id: 0009-worktree-parallel-carrier
target: workflows/parallel.md
anchor: ".agent/rules/worktree-collaboration.md"
---

---

## Worktree 并行载体补充

当同批任务需要真实并行开发时，先读取 `.agent/rules/worktree-collaboration.md`，执行 `--isolation auto` 预检，将批次解析为 `shared`、`locked`、`worktree` 或 `serial`。

- 适合：不同模块/目录、独立验证、需要独立 dev server 或运行状态
- 不适合：共享同一契约、公共类型、迁移文件、独占设备或远程环境
- 解析为 `worktree` 时自动进入 `/worktree plan`；创建仍由 `/worktree create` 负责
- 同一文件或共享契约写入必须解析为 `serial`，不能用 worktree 强制并行
- 每个 worktree 完成可验证任务后及时 `/ship` 或 `/commit`
- 合并后必须在目标主线 worktree 重新验证功能
