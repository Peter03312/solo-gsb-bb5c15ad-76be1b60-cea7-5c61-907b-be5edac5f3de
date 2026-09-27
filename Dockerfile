# 构建阶段：自动安装依赖并构建（含引用完整性检查在内的全部功能）
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# 运行阶段：nginx 托管静态文件（Compose 映射到 8080 端口）
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
