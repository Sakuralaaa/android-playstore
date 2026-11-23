# DroidCloud

**自托管原生 Android 云手机（正版 Google Play + 低延迟 WebCodecs 控制台）**

彻底告别传统 `Xvfb + Fluxbox + x11vnc + noVNC` 的卡顿与粗糙桌面界面。DroidCloud 以 **无头 KVM 模式 (`-no-window`)** 运行官方 Google Play Android 模拟器，通过内置 **`scrcpy-server v5.0.1` + WebSocket H.264 视频流 + 浏览器 WebCodecs 硬件解码** 将手机画面直出到现代暗色云手机 Web 控制台，单端口原生兼容 **Atoll / Caddy / Nginx** 反向代理。

---

## 核心特性

- **极致流畅（无物理 GPU 环境专属优化）**
  - 完全移除 X11 / Fluxbox / x11vnc / noVNC / Qt 窗口渲染链路
  - 直采 Android `MediaCodec` H.264 视频流，浏览器 `WebCodecs` 硬件解码（非 HTTPS 环境下自动降级纯 JS `fMP4 MSE` 硬解）
  - 默认 `720×1600@320dpi`（20:9 原生 Pixel 比例），相比 1080p 减少 **2.25×** 软渲染像素负载，网页内可实时切换 **流畅 / 均衡 / 高清** 三档码率与帧率
- **完整 Google 生态体验**
  - 官方 `google_apis_playstore` 未 Root 系统镜像（支持 Android 14 / 15 / 16）
  - 可直接登录/注册 Google 账号，正常使用 Google Play 商店、YouTube、Gmail、Chrome 等应用
  - 支持配置模拟器代理（`HTTP_PROXY_URL`）、自定义 DNS、虚拟 GPS 定位与安全关机快照保存
- **像原生手机一样的操作手感**
  - 原生触屏滑屏 / 惯性滚动 / 手机浏览器真多点触控
  - 桌面端 **左键滑屏 · 右键返回 · 中键主页 · 滚轮滚动 · `Alt + 拖拽` 双指缩放**
  - **无障碍中英文输入**：直接敲键盘输入英文，自动捕获本机中文输入法提交，并内置 `Ctrl+K` 中文/文本直发弹窗与双向剪贴板同步
- **开箱即用的云手机控制台**
  - **密码登录保护**：HMAC-SHA256 HttpOnly 会话 Cookie + 防爆破限流 + HTTPS 自动 Secure
  - **实时开机与镜像下载进度页**：首次下载 2–3 GB 系统镜像时显示阶段进度与实时日志，就绪自动切入画面
  - **全套工具抽屉**：Google 生态一键启动、第三方应用管理、**全屏拖拽安装 `.apk`**、`/sdcard` 文件上传下载（自动刷新相册）、虚拟定位、高清截图、CPU/内存/码率实时监控

---

## 快速部署

### 前置要求
- Linux `x86_64` 宿主机，已开启 CPU 虚拟化且存在 `/dev/kvm`
- 推荐 4 核 CPU、8 GB 以上内存、15 GB 以上可用磁盘

### 1. Docker Compose 启动

```bash
cp .env.example .env
# 编辑 .env，务必修改 ACCESS_PASSWORD 为你的强密码
docker compose up -d --build
```

打开浏览器访问 `https://你的域名`（或 `http://宿主机IP:6080`），输入密码即可使用。

### 2. Atoll 托管部署建议

1. 本仓库内置 GitHub Actions，每次推送到 `main` 会自动构建并发布镜像 `ghcr.io/sakuralaaa/android-playstore:latest`。
2. 在 Atoll 中配置：
   - **构建方式**：直接拉取本仓库构建 `Dockerfile`，或拉取 `ghcr.io/sakuralaaa/android-playstore:latest`
   - **设备映射**：挂载 `/dev/kvm:/dev/kvm`
   - **共享内存**：`shm_size: 2g`
   - **暴露端口**：仅需反代 HTTP 端口 **`6080`**（WebSocket `/ws` 复用同一端口，无需额外开放 UDP/VNC 端口）
   - **环境变量**：设置 `ACCESS_PASSWORD`、`ANDROID_VERSION=16`、`SCREEN_PRESET=balanced`、`RAM_MB=4096`、`CORES=4`
   - **持久化卷**：挂载 `/opt/android-sdk` 和 `/root/.android`（若从旧项目迁移，直接复用原有卷即可免重新下载系统镜像）

---

## 环境变量说明

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ACCESS_PASSWORD` | 自动生成 | Web 控制台访问密码；若留空首次启动会自动生成并输出到容器日志 |
| `PORT` | `6080` | Web 控制台与 WebSocket 统一监听端口 |
| `ANDROID_VERSION` | `16` | Android 版本：`14` / `15` / `16` |
| `IMG_TAG` | `google_apis_playstore` | 系统镜像类型（默认带正版 Google Play 商店） |
| `DEVICE` | `pixel_7` | 虚拟设备型号 |
| `RAM_MB` | `4096` | 分配给 Android 的内存（MB） |
| `CORES` | `4` | 分配给 Android 的 CPU 核心数 |
| `DATA_SIZE` | `16G` | 手机内部存储容量 |
| `SCREEN_PRESET` | `balanced` | 屏幕分辨率：`smooth` (`540×1200`) / `balanced` (`720×1600`) / `hd` (`1080×2400`) |
| `STREAM_PRESET` | `balanced` | 初始视频流画质：`smooth` / `balanced` / `ultra`（网页内可实时切换） |
| `LANG_LOCALE` | `zh-CN` | 系统语言（如 `zh-CN`、`en-US`） |
| `TZ` | `Asia/Shanghai` | 系统时区 |
| `DNS_SERVERS` | `8.8.8.8,1.1.1.1` | 模拟器 DNS |
| `HTTP_PROXY_URL` | 空 | 可选 HTTP 代理（如 `http://192.168.1.2:7890`） |
| `EXPOSE_ADB` | `false` | 是否对外暴露 `5555` ADB 端口（公网环境建议保持 `false`） |

---

## 快捷键与操作指南

- **左键点击 / 拖拽**：原生触屏点击、滑动、长按
- **右键单击**：返回（Back）
- **中键单击**：回到桌面（Home）
- **滚轮 / 触控板**：上下左右滚动列表
- **`Alt` + 左键拖拽**：双指缩放（Pinch-to-Zoom）
- **`Ctrl+K` / `Cmd+K`**：打开中文 / 长文本直发弹窗
- **拖拽 `.apk` 到页面任意位置**：自动上传并安装到手机
- **拖拽普通文件到页面**：自动保存到 `/sdcard/Download` 并通知系统相册刷新

---

## 本地运行测试

```bash
node --test tests/*.test.mjs
```
