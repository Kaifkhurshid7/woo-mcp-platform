# Build context is the REPOSITORY ROOT (the Helm charts are baked in): see scripts/build-images.sh
#   docker build -f services/provisioner/Dockerfile -t woo-platform/provisioner:dev .
FROM alpine:3.20 AS helm
ARG HELM_VERSION=v3.16.4
RUN apk add --no-cache curl tar \
 && curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" | tar -xz -C /tmp \
 && mv /tmp/linux-amd64/helm /usr/local/bin/helm

FROM node:22-alpine
ENV NODE_ENV=production NODE_NO_WARNINGS=1
COPY --from=helm /usr/local/bin/helm /usr/local/bin/helm
WORKDIR /app
COPY services/provisioner/package.json ./
COPY services/provisioner/src ./src
# The charts the provisioner installs into each new namespace.
COPY charts/platform /charts/platform
COPY charts/hosted-mcp /charts/hosted-mcp
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
