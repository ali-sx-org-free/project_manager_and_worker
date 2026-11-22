# agent-pm 插件

Claude Code 插件：`agent-pm-pm`（PM）和 `agent-pm-worker`（Worker）兩個 Skill，加上 `apm` 命令行。
hub 是一個私有 GitHub 倉庫，不需要任何服務器。

```
/plugin marketplace add ali-sx-org-free/project_manager_and_worker
/plugin install agent-pm@agent-pm
```

- `bin/apm`：插件啟用時在 Claude Code 的 PATH 上
- `lib/apm.mjs`：打包好的 apm（Node 20 以上），由 `npm run build:apm` 從 `packages/github` 生成，不要手改
- 不用 Claude Code 的 agent：`node lib/apm.mjs setup --hub owner/repo` 會在 `~/.agent-pm/bin/apm` 裝一個啟動器

完整說明見倉庫的 `docs/GITHUB.md`。
