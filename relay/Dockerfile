# Minimal image for the TP-Link V2 cloud forwarder. No deps beyond Node built-ins.
FROM node:22-alpine
WORKDIR /app
COPY forwarder.mjs tplink-roots.pem ./
EXPOSE 8080
CMD ["node", "forwarder.mjs"]
