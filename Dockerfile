# DroidCloud - Headless Android Emulator (Google Play) + Low-Latency WebCodecs Console
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    ANDROID_HOME=/opt/android-sdk \
    PATH="/opt/android-sdk/platform-tools:/opt/android-sdk/emulator:${PATH}" \
    QT_QPA_PLATFORM=offscreen \
    PORT=6080

ARG UBUNTU_MIRROR=http://archive.ubuntu.com/ubuntu
ARG SCRCPY_VERSION=5.0.1

RUN if [ "${UBUNTU_MIRROR}" != "http://archive.ubuntu.com/ubuntu" ]; then \
      sed -i "s|http://archive.ubuntu.com/ubuntu|${UBUNTU_MIRROR}|g; s|http://security.ubuntu.com/ubuntu|${UBUNTU_MIRROR}|g" /etc/apt/sources.list.d/ubuntu.sources; \
    fi \
    && printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::Queue-Mode "access";\n' > /etc/apt/apt.conf.d/80-retries \
    && apt-get update && apt-get install -y --no-install-recommends \
      nodejs \
      openjdk-17-jre-headless \
      curl unzip ca-certificates procps socat tzdata \
      libpulse0 libgl1 libegl1 libgbm1 libnss3 \
      libx11-6 libxcb1 libxcb-cursor0 libxkbcommon0 \
      libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 \
      libxkbfile1 libxrandr2 libasound2t64 libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*

# Pre-install scrcpy-server binary (pinned exact version)
RUN mkdir -p /opt/scrcpy \
    && curl -fSL "https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}" \
       -o /opt/scrcpy/scrcpy-server \
    && chmod 644 /opt/scrcpy/scrcpy-server

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /apks

VOLUME ["/opt/android-sdk", "/root/.android"]
EXPOSE 6080

HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
