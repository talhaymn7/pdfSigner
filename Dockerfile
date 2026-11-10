# 1) Build: install deps and bundle the app inside the container only.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY index.html ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# 2) Serve: tiny static web server, no Node at runtime.
FROM nginx:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
