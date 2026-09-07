FROM nginx:1.27-alpine

RUN apk update && apk upgrade --no-cache

ENV BACKEND_ORIGIN=http://backend:8080
ENV PORT=8080

COPY frontend/index.html /usr/share/nginx/html/index.html
COPY frontend/app.js /usr/share/nginx/html/app.js
COPY frontend/styles.css /usr/share/nginx/html/styles.css
COPY frontend/favicon.svg /usr/share/nginx/html/favicon.svg
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ > /dev/null || exit 1
