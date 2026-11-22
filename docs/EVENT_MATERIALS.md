# 大会日历与官方资料抓取

首页显示未来已确认（含进行中）的大会、最近 30 天内结束的大会，
以及尚未公布日期的核心大会。近期大会按结束日期倒序排列，日期边界使用北京时间。
预警统计窗口沿用配置中的 `lookahead_days`（默认 180 天），更远的已确认大会仍保留在列表。

每场大会的【抓取】打开独立的 `event.html?id=sc&cycle=2026&capture=1` 页面。
所有访客都可查看已有资料及提交 GitHub Actions 抓取任务，无需登录或输入口令。
页面显示排队、执行、失败及等待发布状态，不会在打开页面时自动启动任务。

## 收集范围与费用

- 从 `config/industry-events.json` 的 `source_url` 及其官网首页发现资料。
- 可在单个大会配置中增加 `research_sources`（HTTPS URL 数组），用于显式补充
  官方新闻栏目、会议日程站或厂商发布页；只抓取这些种子 URL 的精确主机名。
- 最多访问 16 个内容页面，单页最多 1.5 MB；尊重 robots.txt，拒绝非公网主机，
  不跨白名单主机跟随重定向。不需要登录、cookie 或社交平台 API。
- 按 Keynote、技术报告、新闻、议程等栏目和关键词排序。保留官方简介及短摘录，
  不转载全文；收集 PDF、演示文稿和视频外链，不下载或声称已经分析其内容。
- 不调用大模型、付费搜索或付费翻译。英文保留原文，可由读者使用浏览器翻译。
- GitHub Actions 和 Vercel 仍受各自账户的运行额度和计费政策约束。
- 全部来源失败时任务失败，保留旧资料；部分失败时发布可用资料并显示失败清单。

## 网页触发入口配置（Vercel）

### 第一次配置

1. 将本次代码提交推送到 GitHub 的 `master` 分支，确认 Actions 中出现
   **Collect Event Materials**。此时已有资料可查看，公开抓取尚不能启动。
2. 登录 Vercel，选择 **Add New → Project**，导入自己的
   `shengjiangbanxia/ai-industry-news` 仓库。框架选择 **Other**，Root Directory
   保持仓库根目录；仓库已有 `vercel.json`，不需要迁移 GitHub Pages 或改域名。
3. 登录 Upstash，创建 Redis 数据库，按当前账户可用额度选择方案。将数据库的
   REST URL 和 REST Token 添加到 Vercel 项目的环境变量；也可以通过 Vercel 的
   Storage / Marketplace 集成连接 Upstash，确认最终变量名与下面表格一致。
4. 在 GitHub 的 **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token** 创建令牌。Repository access 仅选本仓库，
   Actions 设为 **Read and write**，Contents 设为 **Read-only**。设置合适有效期，
   将令牌放入 Vercel 的 `EVENT_CAPTURE_GITHUB_TOKEN` 环境变量，不发到聊天或写入代码。
5. 保存所有环境变量，重新部署 Vercel。记下生产地址；如果浏览器请求会被 Vercel
   Deployment Protection 要求登录，应使用面向公众的生产地址，不使用受保护的预览地址。
6. 编辑 `config/event-capture.json`，把 `api_url` 改为实际的
   `https://你的生产域名/api/event-capture`，提交推送，让 GitHub Pages 获得此公开地址。
7. 打开 GitHub Pages 的 SC26 详情页，点击【抓取】、【开始抓取】。已有 6 小时内资料
   时应直接复用；否则出现排队提示。用未登录 GitHub 的浏览器验证同样可用。

首次运行时若 GitHub 拒绝提交 JSON，请检查仓库 **Settings → Actions → General**
的工作流权限及分支规则。不要为了测试移除分支保护；按仓库要求调整发布路径。
Vercel 和 Redis 的额度与费用以当前账户控制台为准，建议先设置用量通知。

先将代码及 `.github/workflows/collect-event-materials.yml` 发布到仓库默认分支，
在 Vercel 项目的服务端 Environment Variables 配置以下变量，然后重新部署：

| 变量 | 用途 |
| --- | --- |
| `EVENT_CAPTURE_GITHUB_TOKEN` | 仅授权此仓库的 GitHub fine-grained token：Actions 为 Read and write，Contents 为 Read；用于触发任务、查询状态及读取已有资料时间。 |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis 数据库的 HTTPS REST 地址，用于跨服务实例共享限额、任务锁和状态缓存。 |
| `UPSTASH_REDIS_REST_TOKEN` | 同一数据库的服务端读写令牌。 |
| `EVENT_CAPTURE_ALLOWED_ORIGINS` | 可选，逗号分隔的允许网页来源（只写 origin，不含路径）；默认 `https://shengjiangbanxia.github.io`。Vercel 自动提供的当前部署与生产域名也会加入白名单，自定义域名需在此列出。 |
| `EVENT_CAPTURE_REPOSITORY` | 可选，默认 `shengjiangbanxia/ai-industry-news`，fork 时修改。 |
| `EVENT_CAPTURE_BRANCH` | 可选，默认 `master`。 |

不再需要 `EVENT_CAPTURE_ADMIN_KEY`。不要将任何服务端令牌提交到仓库、前端代码
或浏览器存储。网页仅提交大会 ID 与年份，不持有 GitHub 或 Redis 凭据。
接口只接受配置中存在的大会和年份，无法提交任意网址。

公开入口的默认限制：

- 同一大会 6 小时内存在成功或部分成功的资料时，直接复用，不创建新任务。
- 已在执行的同一大会复用任务；GitHub 尚未显示任务时，Redis 原子锁防止重复提交。
- 同一 IP 每小时最多 3 次新任务请求，全站每个北京时间自然日最多 12 次，两个新任务至少间隔 60 秒。
- 任务锁保留 15 分钟，状态缓存 15 秒；拒绝请求返回 `Retry-After`。
- 所有额度检查与锁定在同一次 Redis Lua 操作中完成，不依赖服务端进程内存。
- 共享存储不可用时拒绝新任务，不降级为不受限制的调用。网络超时不确定是否已经派发时保留锁。
- 只在 Redis 保存加盐后的 IP 哈希，过期时间一小时，不把访客 IP 写入仓库。
- 这些限制控制新任务，不代表对所有 HTTP 请求实施了 DDoS 防护；托管平台仍执行自身的请求限制。

GitHub Pages 继续托管前端时，在 `config/event-capture.json` 的 `api_url` 填写
已部署的 HTTPS 服务地址，例如 `https://YOUR-PROJECT.vercel.app/api/event-capture`。
此配置只包含公开地址，不包含任何密钥；Vercel 同源部署可保持空字符串。
跨域调用使用服务端的精确来源白名单，无需向访客开放仓库权限。
GitHub workflow 本身使用 `GITHUB_TOKEN` 提交 JSON，不使用额外付费接口密钥。

只部署 GitHub Pages、但未部署上述接口及配置 `api_url` 时，公开抓取不可用。
详情页会明确提示，管理员仍可登录 GitHub → Actions → Collect Event Materials →
Run workflow，填写 `event_id` 和 `cycle`。这个备用入口不能赋予普通访客抓取能力。
服务端配置完成后，普通访客点击【开始抓取】即可启动或复用任务。
Redis 与托管平台均受账户额度/计费政策约束，不承诺所有基础设施费用为零。
GitHub Pages 项目站的资料 JSON 直接从同一公开仓库的 `master` 分支读取，
避免 `GITHUB_TOKEN` 产生的提交不触发 Pages 重建而看不到新资料。
fork 如果改用其他分支，需对应调整 `assets/event.js` 的公开资料地址。

## 输出与验证

输出为 `data/event-materials/<event_id>-<cycle>.json`，包含抓取时间、原始网页、
原文摘录、来源标注、资料链接及失败清单。任务完成后，等待站点发布该提交，
详情页会轮询任务状态并重载 JSON；最长自动等待 12 分钟，之后可手动刷新。

```powershell
.venv\Scripts\python.exe -X utf8 scripts/collect_event_materials.py --event-id sc --cycle 2026
.venv\Scripts\python.exe -X utf8 -m pytest -q
node --test tests/event-calendar.test.cjs tests/event-capture.test.cjs tests/event-client.test.cjs
```
