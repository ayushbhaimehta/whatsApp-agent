FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PATH=/opt/venv/bin:$PATH \
    TZ=Asia/Kolkata

# whatsapp-web.js needs a real Chromium process. The Python virtual environment
# contains the stock-report engine's dependencies. Both packages are available
# for Oracle's ARM64 Always Free VMs as well as ordinary x86-64 machines.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        python3 \
        python3-pip \
        python3-venv \
        tini \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json requirements.txt ./
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

COPY --chown=node:node . .

# UID 1000 is the standard `node` user in the base image. On the VM the
# cloud-data bind mount is assigned to the same UID so secrets stay writable
# without running Chromium or the agent as root.
RUN mkdir -p /data && chown node:node /data
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]
