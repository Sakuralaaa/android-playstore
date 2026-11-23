#!/usr/bin/env bash
# DroidCloud entrypoint:
# 1. Start Web Console immediately (login + live boot progress)
# 2. Download Android SDK / Google Play system image on first run
# 3. Create & tune Pixel AVD for smooth headless KVM + Google ecosystem
# 4. Run headless Android Emulator (-no-window, -no-audio) + graceful shutdown
set -euo pipefail

SDK="${ANDROID_SDK_ROOT:-/opt/android-sdk}"
CMDLINE_VER="${CMDLINE_VER:-16111833}"
ANDROID_VERSION="${ANDROID_VERSION:-16}"
IMG_TAG="${IMG_TAG:-google_apis_playstore}"
ABI="${ABI:-x86_64}"
DEVICE="${DEVICE:-pixel_7}"
RAM_MB="${RAM_MB:-4096}"
CORES="${CORES:-4}"
DATA_SIZE="${DATA_SIZE:-16G}"
GPU="${GPU:-swiftshader_indirect}"
SCREEN_PRESET="${SCREEN_PRESET:-balanced}"      # smooth (540x1200) | balanced (720x1600) | hd (1080x2400)
STREAM_PRESET="${STREAM_PRESET:-balanced}"      # smooth | balanced | ultra
LANG_LOCALE="${LANG_LOCALE:-zh-CN}"
DNS_SERVERS="${DNS_SERVERS:-8.8.8.8,1.1.1.1}"
ANIMATION_SCALE="${ANIMATION_SCALE:-0.5}"
EXPOSE_ADB="${EXPOSE_ADB:-false}"
HTTP_PROXY_URL="${HTTP_PROXY_URL:-${EMU_HTTP_PROXY:-}}"
EMU_PORT="${EMU_PORT:-5560}"

STATE_FILE="/tmp/droidcloud-state.json"
BOOT_LOG="/tmp/droidcloud-boot.log"
: > "$BOOT_LOG"

export PATH="$SDK/platform-tools:$SDK/emulator:$PATH"
export STATE_FILE BOOT_LOG EMU_PORT ANDROID_VERSION DEVICE SCREEN_PRESET STREAM_PRESET LANG_LOCALE

log() {
  local ts
  ts="$(date '+%H:%M:%S')"
  echo "[$ts] [droidcloud] $*" | tee -a "$BOOT_LOG"
}

write_state() {
  local stage="$1"
  local progress="$2"
  local message="$3"
  local ready="${4:-false}"
  local error_json="${5:-null}"
  local tmp="${STATE_FILE}.tmp"
  node --input-type=commonjs -e '
    const fs = require("fs");
    const data = {
      stage: process.argv[1],
      progress: Number(process.argv[2]),
      message: process.argv[3],
      ready: process.argv[4] === "true",
      error: process.argv[5] === "null" ? null : process.argv[5],
      androidVersion: process.env.ANDROID_VERSION || "16",
      device: process.env.DEVICE || "pixel_7",
      screenPreset: process.env.SCREEN_PRESET || "balanced",
      updatedAt: Date.now()
    };
    fs.writeFileSync(process.argv[6], JSON.stringify(data));
  ' "$stage" "$progress" "$message" "$ready" "$error_json" "$tmp"
  mv -f "$tmp" "$STATE_FILE"
}

# Start Web Server right away so the browser UI & login work during boot/download
write_state "init" 5 "正在启动 Web 控制台并检查运行环境…" "false"
node /app/server/index.mjs 2>&1 | tee -a "$BOOT_LOG" &
WEB_PID=$!
EMU_PID=""

cleanup() {
  log "收到停止信号，正在安全保存 Android 状态并退出…"
  if [[ -n "$EMU_PID" ]] && kill -0 "$EMU_PID" 2>/dev/null; then
    "$SDK/platform-tools/adb" -s "emulator-${EMU_PORT}" emu kill >/dev/null 2>&1 || kill -TERM "$EMU_PID" 2>/dev/null || true
    for _ in $(seq 1 15); do
      kill -0 "$EMU_PID" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$EMU_PID" 2>/dev/null || true
  fi
  if kill -0 "$WEB_PID" 2>/dev/null; then
    kill -TERM "$WEB_PID" 2>/dev/null || true
  fi
  exit 0
}
trap cleanup SIGTERM SIGINT

# ---------- 1. Validate Android version & KVM ----------
case "$ANDROID_VERSION" in
  14) API="android-34" ;;
  15) API="android-35" ;;
  16) API="android-36" ;;
  17) API="android-37.0" ;;
  *)
    write_state "error" 10 "不支持的 ANDROID_VERSION=${ANDROID_VERSION}（可选 14 / 15 / 16 / 17）" "false" "unsupported_version"
    log "错误：不支持的 ANDROID_VERSION=${ANDROID_VERSION}"
    wait "$WEB_PID"
    exit 1
    ;;
esac

if [[ ! -e /dev/kvm ]]; then
  write_state "error" 10 "未检测到 /dev/kvm，请使用 --device /dev/kvm 启动容器" "false" "no_kvm"
  log "错误：未检测到 /dev/kvm，无法开启 KVM 硬件虚拟化加速"
  wait "$WEB_PID"
  exit 1
fi

PKG="system-images;${API};${IMG_TAG};${ABI}"
AVD_NAME="${AVD_NAME:-phone-a${ANDROID_VERSION}-${IMG_TAG}}"
log "目标配置: Android ${ANDROID_VERSION} (${PKG}), 机型=${DEVICE}, 分辨率档位=${SCREEN_PRESET}, RAM=${RAM_MB}MB, CPU=${CORES}核"

# ---------- 2. Download Android commandline-tools (first run only) ----------
SDKM="$SDK/cmdline-tools/latest/bin/sdkmanager"
AVDM="$SDK/cmdline-tools/latest/bin/avdmanager"

if [[ ! -x "$SDKM" ]]; then
  write_state "downloading_sdk" 15 "首次运行：正在下载 Android 命令行工具…" "false"
  log "正在下载 Android Commandline Tools (${CMDLINE_VER})…"
  mkdir -p "$SDK/cmdline-tools"
  curl -fSL "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_VER}_latest.zip" -o /tmp/clt.zip
  unzip -q /tmp/clt.zip -d /tmp/clt
  mv /tmp/clt/cmdline-tools "$SDK/cmdline-tools/latest"
  rm -rf /tmp/clt /tmp/clt.zip
fi

yes | "$SDKM" --licenses >/dev/null 2>&1 || true

# ---------- 3. Download Emulator & Google Play system image (first run only) ----------
if [[ ! -d "$SDK/system-images/${API}/${IMG_TAG}/${ABI}" || ! -x "$SDK/emulator/emulator" || ! -x "$SDK/platform-tools/adb" ]]; then
  write_state "downloading_image" 30 "首次运行：正在下载 Android ${ANDROID_VERSION} (Google Play) 系统镜像，约 2-3 GB…" "false"
  log "开始下载 platform-tools、emulator 和 ${PKG}…"
  "$SDKM" --install "platform-tools" "emulator" "$PKG" 2>&1 | tr '\r' '\n' | awk 'NF' | tee -a "$BOOT_LOG"
  write_state "downloading_image" 62 "系统镜像下载与解压完成" "false"
else
  log "检测到已缓存的 Android SDK 与系统镜像，跳过下载"
fi

export PATH="$SDK/platform-tools:$SDK/emulator:$PATH"

# ---------- 4. Create & optimize Pixel AVD ----------
write_state "creating_avd" 68 "正在配置虚拟手机硬件参数…" "false"
AVD_DIR="/root/.android/avd/${AVD_NAME}.avd"

if [[ ! -d "$AVD_DIR" ]]; then
  log "创建虚拟设备 ${AVD_NAME}…"
  echo no | "$AVDM" create avd -n "$AVD_NAME" -k "$PKG" -d "$DEVICE" --force 2>&1 | tee -a "$BOOT_LOG"
fi

case "$SCREEN_PRESET" in
  smooth)   LCD_W=540;  LCD_H=1200; LCD_DPI=240 ;;
  hd)       LCD_W=1080; LCD_H=2400; LCD_DPI=420 ;;
  balanced|*) LCD_W=720; LCD_H=1600; LCD_DPI=320 ;;
esac

cfg="$AVD_DIR/config.ini"
if [[ -f "$cfg" ]]; then
  OLD_W="$(grep -E '^hw\.lcd\.width=' "$cfg" | tail -n1 | cut -d= -f2 || true)"
  OLD_H="$(grep -E '^hw\.lcd\.height=' "$cfg" | tail -n1 | cut -d= -f2 || true)"
  if [[ -n "$OLD_W" && ( "$OLD_W" != "$LCD_W" || "$OLD_H" != "$LCD_H" ) ]]; then
    log "检测到屏幕分辨率变化 (${OLD_W}x${OLD_H} -> ${LCD_W}x${LCD_H})，清理旧 QuickBoot 快照以冷启动生效"
    rm -rf "$AVD_DIR/snapshots/default_boot" 2>/dev/null || true
  fi
  sed -i '/^hw\.keyboard=/d;/^hw\.ramSize=/d;/^hw\.cpu\.ncore=/d;/^disk\.dataPartition\.size=/d;/^hw\.lcd\.width=/d;/^hw\.lcd\.height=/d;/^hw\.lcd\.density=/d;/^hw\.gps=/d;/^hw\.sensors\.orientation=/d;/^hw\.battery=/d;/^fastboot\.forceFastBoot=/d;/^PlayStore\.enabled=/d' "$cfg"
  {
    echo "hw.keyboard=yes"
    echo "hw.ramSize=${RAM_MB}"
    echo "hw.cpu.ncore=${CORES}"
    echo "disk.dataPartition.size=${DATA_SIZE}"
    echo "hw.lcd.width=${LCD_W}"
    echo "hw.lcd.height=${LCD_H}"
    echo "hw.lcd.density=${LCD_DPI}"
    echo "hw.gps=yes"
    echo "hw.sensors.orientation=yes"
    echo "hw.battery=yes"
    echo "fastboot.forceFastBoot=yes"
    if [[ "$IMG_TAG" == "google_apis_playstore" ]]; then
      echo "PlayStore.enabled=true"
    fi
  } >> "$cfg"
  log "已优化 AVD 屏幕为 ${LCD_W}x${LCD_H}@${LCD_DPI}dpi (${SCREEN_PRESET})，RAM=${RAM_MB}MB，CPU=${CORES}核"
fi

# Clean stale lock files from ungraceful previous shutdowns
rm -f "$AVD_DIR"/*.lock "$AVD_DIR"/hardware-qemu.ini.lock 2>/dev/null || true

# Optional external ADB exposure (disabled by default for public cloud security)
if [[ "${EXPOSE_ADB,,}" == "true" ]]; then
  socat TCP-LISTEN:5555,fork,reuseaddr "TCP:127.0.0.1:$((EMU_PORT + 1))" &
  log "已开启外部 ADB 转发端口 5555"
fi

# ---------- 5. Launch Headless KVM Android Emulator ----------
write_state "booting" 76 "正在启动无头 KVM Android 模拟器…" "false"

EMU_ARGS=(
  -avd "$AVD_NAME"
  -port "$EMU_PORT"
  -no-window
  -gpu "$GPU"
  -no-audio
  -no-boot-anim
  -no-metrics
  -memory "$RAM_MB"
  -cores "$CORES"
  -dns-server "$DNS_SERVERS"
  -change-locale "$LANG_LOCALE"
)

if [[ -n "$HTTP_PROXY_URL" ]]; then
  EMU_ARGS+=(-http-proxy "$HTTP_PROXY_URL")
  log "已为模拟器配置网络代理: ${HTTP_PROXY_URL}"
fi

if [[ -n "${EMU_EXTRA_ARGS:-}" ]]; then
  # shellcheck disable=SC2206
  EMU_ARGS+=(${EMU_EXTRA_ARGS})
fi

log "启动 emulator (${EMU_ARGS[*]})"
emulator "${EMU_ARGS[@]}" 2>&1 | tee -a "$BOOT_LOG" &
EMU_PID=$!

adb start-server >/dev/null 2>&1 || true
adb -s "emulator-${EMU_PORT}" wait-for-device

write_state "booting" 88 "内核已就绪，正在等待 Android 系统和 Google 服务启动…" "false"
until [[ "$(adb -s "emulator-${EMU_PORT}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r\n')" == "1" ]]; do
  if ! kill -0 "$EMU_PID" 2>/dev/null; then
    write_state "error" 88 "Android 模拟器进程异常退出，请查看日志" "false" "emulator_exited"
    log "错误：emulator 进程意外退出"
    wait "$WEB_PID"
    exit 1
  fi
  sleep 2
done

# ---------- 6. Post-boot native usability tuning ----------
log "Android 系统开机完成，正在应用防休眠与流畅度优化…"
adb -s "emulator-${EMU_PORT}" shell settings put global stay_on_while_plugged_in 7 >/dev/null 2>&1 || true
adb -s "emulator-${EMU_PORT}" shell settings put system screen_off_timeout 2147483647 >/dev/null 2>&1 || true
adb -s "emulator-${EMU_PORT}" shell svc power stayon true >/dev/null 2>&1 || true
adb -s "emulator-${EMU_PORT}" shell settings put global window_animation_scale "$ANIMATION_SCALE" >/dev/null 2>&1 || true
adb -s "emulator-${EMU_PORT}" shell settings put global transition_animation_scale "$ANIMATION_SCALE" >/dev/null 2>&1 || true
adb -s "emulator-${EMU_PORT}" shell settings put global animator_duration_scale "$ANIMATION_SCALE" >/dev/null 2>&1 || true
# Dismiss initial lock screen if present
adb -s "emulator-${EMU_PORT}" shell wm dismiss-keyguard >/dev/null 2>&1 || true

# ---------- 7. Auto-install preloaded APKs in /apks ----------
shopt -s nullglob
apks=(/apks/*.apk)
if (( ${#apks[@]} > 0 )); then
  write_state "installing_apks" 95 "正在安装 /apks 目录下的预置应用…" "false"
  for apk in "${apks[@]}"; do
    log "自动安装 $(basename "$apk")…"
    adb -s "emulator-${EMU_PORT}" install -r "$apk" 2>&1 | tee -a "$BOOT_LOG" || log "安装失败: $apk"
  done
fi

write_state "ready" 100 "Android ${ANDROID_VERSION} 已就绪，正在建立低延迟视频流" "true"
log "云手机已完全就绪！可通过 Web 控制台访问。"

# Keep container alive as long as emulator & web server run
wait -n "$EMU_PID" "$WEB_PID"
cleanup
