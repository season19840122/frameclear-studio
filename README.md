# 图片视频去水印工具 · FrameClear Studio

一个在本地运行的图片与视频处理工作台，用于用户拥有版权、已获授权或允许编辑的素材。它不应用于移除他人的署名、版权标识或权利管理信息。

## 技术栈

- 前端：Vue 3、TypeScript、Vite、原生 CSS 设计系统、Lucide 图标
- 后端：Node.js、Express、TypeScript、SQLite（better-sqlite3）
- 处理：Sharp（图片）、FFmpeg / FFprobe（视频）
- 任务：SQLite 持久化队列，默认并发 3，可恢复 Waiting / Processing / Paused 状态

## 本地启动

要求：Node.js 22+；如需处理视频，安装 FFmpeg 并确保 `ffmpeg`、`ffprobe` 在 `PATH` 中。

```bash
npm install
npm run dev
```

- 前端：<http://localhost:5173>
- 后端：<http://localhost:8787>

生产构建与启动：

```bash
npm run build
npm run start
```

## 环境变量

复制 `.env.example` 为 `.env` 后可配置：`PORT`、`MAX_FILE_SIZE_MB`、`DEFAULT_CONCURRENCY`、`OUTPUT_DIRECTORY`。图片“智能修复”需要 `OPENAI_API_KEY`，使用 OpenAI 图像编辑接口按选区生成修复结果；未配置时任务会给出明确提示，不会伪造输出。

## Docker

```bash
docker compose up -d --build
```

容器只提供 API；生产环境可将 `client/dist` 放在任意静态文件服务器，或通过反向代理提供。

## 主要功能

- 上传 JPG / JPEG / PNG / WEBP / MP4 / MOV / WEBM；后端验证格式、大小和媒体可读性。
- 文件预览、多个矩形处理区域、选区移动、缩放、删除、撤销与重做；视频支持全片或指定时间段。
- 图片智能修复（OpenAI 图像编辑）、模糊覆盖、纯色覆盖、裁剪去除；视频使用局部 `delogo` 智能修复、局部模糊或纯色覆盖。
- 可设置输出格式、质量、保存目录、并发、资源上限、超时与自动重试；任务排队、进度、暂停、继续、取消、重试、删除历史记录和删除实际输出文件。
- SQLite 状态持久化；服务重启后会将中断的 Processing / Parsing 任务恢复到 Waiting。
- Dashboard、历史筛选、设置与 Light / Dark / System 外观。

> 图片智能修复不会在没有凭证时降级成伪修复；请设置 `OPENAI_API_KEY` 后使用。视频处理使用 FFmpeg，并且所有模式仅作用于已选区域；指定时间段会保留其它时段原样。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/health` | 服务健康状态 |
| `POST` | `/api/uploads` | 上传并解析媒体（`file` multipart 字段） |
| `GET/POST` | `/api/tasks` | 获取任务、创建任务 |
| `POST` | `/api/tasks/:id/pause|resume|cancel|retry` | 任务控制 |
| `DELETE` | `/api/tasks/:id` | 删除任务历史记录 |
| `DELETE` | `/api/tasks/:id/output` | 仅删除实际输出文件 |
| `GET/PUT` | `/api/settings` | 获取、保存设置 |
| `GET` | `/api/dashboard` | Dashboard 聚合数据 |

## 目录

```text
client/       Vue 应用与交互界面
server/       Express API、SQLite、队列和处理器
design/       生成的视觉概念基准
uploads/      上传文件（运行时创建）
outputs/      处理结果（运行时创建）
data/         SQLite 数据库（运行时创建）
```

## 常见问题

- **视频解析失败**：确认 FFmpeg / FFprobe 已安装，且视频未损坏或加密。
- **文件过大**：在设置中调高限制后重启服务，或通过 `MAX_FILE_SIZE_MB` 配置。
- **删除记录后文件还在**：这是有意设计。删除历史与删除实际输出文件被严格区分，避免误删用户素材。
