FROM golang:1.23-alpine AS builder

# Install protoc and protoc-gen-go
RUN apk add --no-cache protobuf-dev
RUN go install google.golang.org/protobuf/cmd/protoc-gen-go@latest

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Generate Go code from local proto files
RUN protoc --go_out=. --go_opt=paths=source_relative proto/weather.proto

RUN CGO_ENABLED=0 GOOS=linux go build -o mcp-server ./main.go

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/

COPY --from=builder /app/mcp-server .

EXPOSE 8443

CMD ["./mcp-server"]