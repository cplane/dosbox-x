# The browser client: a Vite/React bundle served by nginx, which also proxies
# /api to the gateway and /auth to the auth service so everything is one
# origin. Build context = platform/web (see platform/build.sh).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
