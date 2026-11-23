#!/usr/bin/env bash
# DroidCloud Multi-Phone Control Plane Entrypoint
# Starts immediately in ultra-low-resource idle mode (~35MB RAM, ~0% CPU).
# Cloud phones are created, booted, and stopped on-demand from the Web Console.
set -euo pipefail

export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/opt/android-sdk}"
export ANDROID_HOME="${ANDROID_SDK_ROOT}"
export ANDROID_AVD_HOME_PARENT="${ANDROID_AVD_HOME_PARENT:-/root/.android}"
export PATH="${ANDROID_SDK_ROOT}/platform-tools:${ANDROID_SDK_ROOT}/emulator:${PATH}"
export QT_QPA_PLATFORM="offscreen"

mkdir -p "${ANDROID_SDK_ROOT}" "${ANDROID_AVD_HOME_PARENT}/avd" /apks

exec node /app/server/index.mjs
