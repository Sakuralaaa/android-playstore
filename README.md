# DroidCloud

**自托管多机原生 Android 云手机平台（正版 Google Play + 按需开机 + 出口 IP 环境自动同步 + 低延迟 WebCodecs 控制台）**

彻底告别传统 `Xvfb + Fluxbox + x11vnc + noVNC` 的卡顿与粗糙桌面界面。DroidCloud 以 **无头 KVM 模式 (`-no-window -no-audio`)** 运行官方 Google Play Android 模拟器，通过内置 **`scrcpy-server v5.0.1` + WebSocket H.264 视频流 + 浏览器 WebCodecs 硬件解码** 直出到现代暗色云手机控制台，单端口原生兼容 **Atoll / Caddy / Nginx** 反向代理。

---

## 核心特性

- **多云手机管理 & 按需开机（极大降低 CPU/内存压力）**
  - 容器启动后进入轻量待命状态（仅占用约 ~35 MB 内存、~0% CPU），所有云手机默认**关机**，需要哪台点哪台**一键开机**
  - 支持自由创建多台独立云手机，每台可单独选择 **Android 14 / 15 / 16（正版 Google Play）**、**Pixel 9 / 8 / 8 Pro / 7 / 7 Pro / 6a / 5 / Tablet** 型号、屏幕分辨率、CPU/内存配额与独立代理
  - 支持 **空闲自动关机**（默认无连接 30 分钟后自动保存 QuickBoot 快照并关机，彻底释放资源），下次开机秒速恢复
  - 自动导入旧版 `/root/.android/avd` 下已有虚拟手机数据，升级无痛迁移
- **开机自动匹配出口 IP 环境（对 Google 生态更友好）**
  - 每台云手机开机前自动检测实际出口 IP（支持穿透每台手机的独立代理 `httpProxy`），自动注入对应 **时区 (`TZ`)** 与 **GPS 经纬度**，消除 IP 与时区/定位不一致导致的风控
  - **系统语言默认简体中文 (`zh-CN`)**，同时可在每台手机配置中一键切换为 **跟随出口 IP 当地语言**（如美区自动 `en-US`、日区 `ja-JP`，推荐注册 Google 账号时使用）
- **极致流畅（无物理 GPU 环境专属优化）**
  - 完全移除 X11 / Fluxbox / x11vnc / noVNC / Qt 窗口渲染链路
  - 直采 Android `MediaCodec` H.264 视频流，浏览器 `WebCodecs` 硬件解码（非 HTTPS 环境下自动降级纯 JS `fMP4 MSE` 硬解）
  - 默认 `720×1600@320dpi`（20:9 原生 Pixel 比例），网页内实时切换 **流畅 / 均衡 / 高清** 三档画质
- **原生手机手感 & 完整控制台工具**
  - **密码登录保护**：HMAC-SHA256 HttpOnly Cookie + 防爆破限流 + HTTPS 自动 Secure（自动兼容旧 `VNC_PASSWORD` 变量）
  - 原生触屏滑屏 / 手机浏览器真多点触控 / 右键返回 / 中键主页 / `Alt+拖拽` 双指缩放 / 自动捕获中文输入法 + `Ctrl+K` 中文直发弹窗
  - 工具抽屉：Google 生态一键启动、第三方应用管理、**全屏拖拽安装 `.apk`**、`/sdcard` 文件上传下载（自动刷新相册）、虚拟 GPS 与一键同步 IP、双向剪贴板、宿主机 CPU/内存/磁盘监控

---

## 快速部署

### 前置要求
- Linux `x86_64` 宿主机，已开启 CPU 虚拟化且存在 `/dev/kvm`
- 推荐 4 核 CPU、8 GB 以上内存、20 GB 以上可用磁盘（多版本系统镜像按需下载）

### 1. Docker Compose 启动

```bash
cp .env.example .env
# 编辑 .env，设置 ACCESS_PASSWORD 为你的强密码
docker compose up -d
```

打开浏览器访问 `https://你的域名`（或 `http://宿主机IP:6080`），输入密码进入 **设备中心**，按需开机或新建云手机即可。

### 2. Atoll 托管部署建议

1. 本仓库内置 GitHub Actions，每次推送到 `main` 会自动跑测试并构建发布镜像 `ghcr.io/sakuralaaa/android-playstore:latest`。
2. 在 Atoll 中配置：
   - **镜像 / 构建**：使用 `ghcr.io/sakuralaaa/android-playstore:latest` 或直接拉取本仓库构建 `Dockerfile`
   - **设备映射**：挂载 `/dev/kvm:/dev/kvm`
   - **共享内存**：`shm_size: 2g`
   - **端口反代**：仅需反代 HTTP 端口 **`6080`**（WebSocket `/ws` 复用同一端口）
   - **环境变量**：设置 `ACCESS_PASSWORD`（旧配置中的 `VNC_PASSWORD` 也会自动兼容）
   - **持久化卷**：挂载 `/opt/android-sdk` 和 `/root/.android`

---

## 环境变量说明

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ACCESS_PASSWORD` | 自动生成 | Web 控制台访问密码（兼容 `WEB_PASSWORD` / `VNC_PASSWORD`） |
| `PORT` | `6080` | Web 控制台与 WebSocket 统一监听端口 |
| `ANDROID_VERSION` | `16` | 新建云手机的默认 Android 版本（可在网页中逐台调整） |
| `DEVICE` | `pixel_8` | 新建云手机的默认机型（可在网页中逐台调整） |
| `RAM_MB` / `CORES` | `4096` / `4` | 新建云手机的默认内存与 CPU 核数（可在网页中逐台调整） |
| `SCREEN_PRESET` | `balanced` | 默认屏幕分辨率：`smooth` / `balanced` / `hd` |
| `STREAM_PRESET` | `balanced` | 默认视频推流画质：`smooth` / `balanced` / `ultra` |
| `DNS_SERVERS` | `8.8.8.8,1.1.1.1` | 模拟器默认 DNS |
| `AUTO_START_PHONE` | 空 | 留空表示容器启动后所有手机关机待命；设为 `first` 可自动启动第一台 |

---

## 本地运行测试

```bash
node --test tests/*.test.mjs
```
