FROM python:3.12-slim-bookworm

ARG NODE_VERSION=22.13.0
ARG D2_VERSION=0.7.1
ARG TYPST_VERSION=0.15.1
ARG WHISPER_CPP_VERSION=1.7.6

ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PUPPETEER_SKIP_DOWNLOAD=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV TZ=Australia/Sydney
ENV AGENT_LOCALE=en
ENV AGENT_TIMEZONE=Australia/Sydney
ENV AGENT_SANDBOX_PROFILE=agent-parity-v1
ENV AGENT_E2B_WORKSPACE_ROOT=/home/user/agent-workspaces
ENV APP_DOMAIN=agent1-0.vercel.app
ENV DISPLAY=:0
ENV RUNTIME_CRASH_STATE_DIR=/home/user/.local/state/agent
ENV WEBDEV_TEMPLATES_PATH=/opt/agent/webdev/templates
ENV AGENT_WHISPER_MODEL=/opt/agent/models/ggml-base.en.bin
ENV JAVA_HOME=/usr/lib/jvm/msopenjdk-21-amd64
ENV PATH=/usr/lib/jvm/msopenjdk-21-amd64/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    chromium \
    cmake \
    curl \
    default-mysql-client \
    ffmpeg \
    file \
    fonts-liberation \
    fonts-noto-color-emoji \
    gh \
    git \
    gnupg \
    gzip \
    imagemagick \
    jq \
    less \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libopenblas-dev \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    openssh-client \
    pandoc \
    plantuml \
    pkg-config \
    poppler-utils \
    procps \
    rclone \
    socat \
    sudo \
    supervisor \
    tar \
    tesseract-ocr \
    tesseract-ocr-eng \
    tzdata \
    unzip \
    wget \
    x11-utils \
    xauth \
    xdg-utils \
    xvfb \
    zip \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    curl -fsSLo "/tmp/node-v${NODE_VERSION}-linux-x64.tar.xz" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    curl -fsSLo /tmp/SHASUMS256.txt "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    grep " node-v${NODE_VERSION}-linux-x64.tar.xz\$" /tmp/SHASUMS256.txt > /tmp/node.sha256; \
    cd /tmp; \
    sha256sum --check node.sha256; \
    tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local --strip-components=1; \
    rm -f "/tmp/node-v${NODE_VERSION}-linux-x64.tar.xz" /tmp/node.sha256 /tmp/SHASUMS256.txt; \
    node --version; \
    npm --version

RUN set -eux; \
    curl -fsSLo /tmp/microsoft.asc https://packages.microsoft.com/keys/microsoft.asc; \
    gpg --dearmor --batch --yes --output /usr/share/keyrings/microsoft-prod.gpg /tmp/microsoft.asc; \
    curl -fsSLo /etc/apt/sources.list.d/microsoft-prod.list https://packages.microsoft.com/config/debian/12/prod.list; \
    rm -f /tmp/microsoft.asc; \
    apt-get update; \
    apt-get install -y --no-install-recommends msopenjdk-21; \
    rm -rf /var/lib/apt/lists/*; \
    java -version

RUN npm install --global \
    @googleworkspace/cli@0.22.3 \
    @mermaid-js/mermaid-cli@11.12.0 \
    pnpm@11.17.0 \
    yarn@1.22.22 \
  && npm cache clean --force

COPY python-requirements.txt /opt/agent/python-requirements.txt
RUN python3 -m pip install --no-cache-dir --requirement /opt/agent/python-requirements.txt

RUN set -eux; \
    curl -fsSLo /tmp/d2.tar.gz "https://github.com/terrastruct/d2/releases/download/v${D2_VERSION}/d2-v${D2_VERSION}-linux-amd64.tar.gz"; \
    tar -xzf /tmp/d2.tar.gz -C /usr/local --strip-components=1 "d2-v${D2_VERSION}/bin/d2"; \
    rm -f /tmp/d2.tar.gz; \
    d2 --version

RUN set -eux; \
    mkdir -p /tmp/typst; \
    curl -fsSLo /tmp/typst.tar.xz "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz"; \
    tar -xJf /tmp/typst.tar.xz -C /tmp/typst; \
    install -m 0755 "$(find /tmp/typst -type f -name typst | head -n 1)" /usr/local/bin/typst; \
    rm -rf /tmp/typst /tmp/typst.tar.xz; \
    typst --version

RUN set -eux; \
    mkdir -p /tmp/whisper /opt/agent/models; \
    curl -fsSLo /tmp/whisper.tar.gz "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${WHISPER_CPP_VERSION}.tar.gz"; \
    tar -xzf /tmp/whisper.tar.gz -C /tmp/whisper --strip-components=1; \
    cmake -S /tmp/whisper -B /tmp/whisper/build \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DGGML_BLAS=ON \
      -DGGML_BLAS_VENDOR=OpenBLAS \
      -DWHISPER_BUILD_TESTS=OFF \
      -DWHISPER_BUILD_EXAMPLES=ON; \
    cmake --build /tmp/whisper/build --config Release --target whisper-cli --parallel 2; \
    install -m 0755 /tmp/whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli; \
    curl -fsSLo /opt/agent/models/ggml-base.en.bin \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin; \
    echo "137c40403d78fd54d454da0f9bd998f78703390c  /opt/agent/models/ggml-base.en.bin" | sha1sum --check; \
    rm -rf /tmp/whisper /tmp/whisper.tar.gz; \
    whisper-cli --help >/dev/null

COPY bin/ /usr/local/bin/
COPY lib/ /opt/agent/lib/
COPY config/ /etc/agent/
COPY templates/ /opt/agent/webdev/templates/
COPY runtime-manifest.json /etc/agent/runtime-manifest.json

RUN set -eux; \
    chmod 0755 /usr/local/bin/agent-*; \
    if ! id -u user >/dev/null 2>&1; then useradd -m -u 1000 -s /bin/bash user; fi

RUN mkdir -p \
      /home/user/agent-workspaces \
      /home/user/.local/state/agent \
      /tmp/agent-supervisor \
  && printf 'user ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/agent-user \
  && chmod 0440 /etc/sudoers.d/agent-user \
  && chown -R user:user /home/user /tmp/agent-supervisor \
  && chromium --version \
  && node --version \
  && npm --version \
  && pnpm --version \
  && yarn --version \
  && python3 --version \
  && java -version \
  && agent-sandbox-info >/dev/null

ENV HOME=/home/user
ENV USER=user
ENV SHELL=/bin/bash

USER user
WORKDIR /home/user
