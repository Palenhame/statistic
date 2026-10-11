# Server Monitor

Локальный мониторинг Linux/macOS/Windows: CPU по ядрам, RAM, swap, диски, сетевой трафик, процессы и история в SQLite.

## Требования
- Go 1.22+
- Node.js 20+ и npm
- Для полного набора метрик лучше запускать на Linux. Некоторые показатели и процессы зависят от ОС и прав доступа.

## Запуск backend
```bash
cd server
go mod tidy
go run ./cmd/server
```
API будет доступен на http://localhost:8080. Сбор метрик — каждые 5 секунд, история хранится в `server-monitor.db`.

Проверка:
```bash
curl http://localhost:8080/api/current
curl 'http://localhost:8080/api/history?range=1h'
```

Переменные окружения:
- `PORT` — порт API (по умолчанию `8080`)
- `SAMPLE_INTERVAL` — интервал сбора, например `5s`
- `DB_PATH` — путь к SQLite (по умолчанию `server-monitor.db`)
- `CORS_ORIGIN` — разрешённый origin фронтенда (по умолчанию `http://localhost:5173`)

## Запуск frontend
В другом терминале:
```bash
cd web
npm install
npm run dev
```
Откройте http://localhost:5173.

## Сборка
```bash
cd server && go build -o monitor ./cmd/server
cd ../web && npm run build
```

## API
- `GET /api/health` — состояние API
- `GET /api/current` — последняя метрика
- `GET /api/history?range=1h|6h|24h|7d` — история
- `GET /api/disks` — разделы диска
- `GET /api/processes` — топ процессов по CPU

## Безопасность
Это прототип для локального использования. Не выставляйте API в интернет без аутентификации, TLS и ограничений доступа. Метрики процессов могут раскрывать информацию о системе.
# statistic
