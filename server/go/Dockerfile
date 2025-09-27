FROM golang:1.25-alpine AS builder

WORKDIR /app

# Copy Go module definition and download deps
COPY server/go/go.mod server/go/go.sum ./
RUN go mod download

# Copy server sources and generated protobuf stubs
COPY server/go ./server/go

WORKDIR /app/server/go
RUN CGO_ENABLED=0 GOOS=linux go build -o /mcp-server ./main.go

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/

COPY --from=builder /mcp-server .

EXPOSE 8443

CMD ["./mcp-server"]
