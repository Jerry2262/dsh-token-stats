# MAINTAINING.md — 自用 fork 维护说明

本仓库是 [MoonlitDropOfBlood/dsh-token-stats](https://github.com/MoonlitDropOfBlood/dsh-token-stats)
的自用 fork（基于上游 v1.8.0），额外功能：汇总卡「缓存命中率」+ 柱状图悬停命中率。

**定位**：只给自己用。不发布 npm、不提交插件市场、不改包名；本地 DSH 通过 link 安装本目录。

## 本地安装

```bash
dsh plugin --profile web add /home/jerry/dsh-token-stats
```

profile 里依赖是 `link:/home/jerry/dsh-token-stats`，改代码即生效（生效范围见 AGENTS.md）。
卸载：`dsh plugin --profile web remove @duke-dsh-plugins/dsh-token-stats`。

## 定期同步上游

```bash
git fetch upstream
git switch main
git merge upstream/main
git push origin main
```

- `origin` = 自己的 fork；`upstream` = 原作者仓库，**push URL 已禁用**，防止误推上游。
- 用 merge，不用 rebase：本地提交已经推送过，merge 不需要 force push。
- 上游节奏很快（一两周一个小版），建议 1–2 周同步一次。
- 冲突重点：`client.js`（汇总卡与图表渲染）、`README.md` / `AGENTS.md`（文档）。
  合并后确认本 fork 的命中率功能还在：汇总卡第二张「缓存命中率」、柱状图悬停「命中 xx%」、`scripts/smoke-cache.mjs`。
- 如果上游自己实现了缓存命中率，冲突时直接采用上游实现，删掉本地对应代码与 `smoke-cache.mjs` 即可。

## 同步后自检

```bash
npm run check
npm run smoke:cache     # 离线渲染冒烟，不需要 DSH
```

其他 e2e 脚本需要 node_modules junction（把 DSH 部署的 `@deepseek-ai` / `zod` 软链进来），见 AGENTS.md。

生效方式：

- 只改 `client.js`：浏览器刷新页面即生效（服务端约 1 秒重组，不用重启 DSH）；
- 改 `index.js` / `typert.host.js`，或安装/卸载/换版本：重启 DSH。

## 不发布

- 不 bump `version`、不打 `v*` tag、不跑 release workflow；`publish-npm` job 保持原样即可（只有打 tag 才会触发）。
- 统计链路不变：仍读写 `<DSH_HOME>/data/dsh-token-stats/stats.json`，与上游安装版本共用同一份历史数据。

## 许可与署名

上游 MIT（Copyright (c) 2026 duke）。本 fork 保留原 `LICENSE` 与署名，README 可补充「fork 自
MoonlitDropOfBlood/dsh-token-stats」。
