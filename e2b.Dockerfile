FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    chromium \
    curl \
    fonts-liberation \
    git \
    file \
    imagemagick \
    jq \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    openssh-client \
    poppler-utils \
    procps \
    python3 \
    python3-pip \
    python3-venv \
    tesseract-ocr \
    tesseract-ocr-eng \
    unzip \
    wget \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

RUN id -u user >/dev/null 2>&1 || useradd -m -s /bin/bash user \
  && mkdir -p /home/user/agent-workspaces \
  && chown -R user:user /home/user

USER user
WORKDIR /home/user

RUN mkdir -p /home/user/agent-workspaces \
  && chromium --version \
  && node --version \
  && python3 --version
