# Этап 1: Сборка фронтенда (React + Vite)
FROM node:20-alpine AS web-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# Этап 2: Сборка Go-сервера
FROM golang:1.22-alpine AS go-builder
WORKDIR /app/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./

# Копируем собранный фронтенд внутрь папки сервера
COPY --from=web-builder /app/web/dist /app/server/dist

RUN CGO_ENABLED=0 GOOS=linux go build -o /app/server-binary ./cmd/server

# Этап 3: Финальный минималистичный образ
FROM alpine:3.20
WORKDIR /app

# Копируем бинарник и статику фронтенда
COPY --from=go-builder /app/server-binary /app/server-binary
COPY --from=go-builder /app/server/dist /app/dist

RUN mkdir -p /app/data

EXPOSE 8080

CMD ["/app/server-binary"]