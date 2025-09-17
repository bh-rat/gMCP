# MCP gRPC (POC)

This is an experimental project that shows gRPC-based MCP tool calls with runtime schemas (gRPC Reflection), a TypeScript client that validates and encodes `google.protobuf.Any`, and a Kong gateway with JWT + metrics. Not production-hardened.

## What’s included
- Protocol definitions in `proto/mcp/v0` (McpService: ListTools, CallTool) with server meta extension, plus vendored gRPC Reflection proto at `proto/grpc/reflection/v1alpha/reflection.proto`.
- gRPC MCP server (Go) with reflection and sample tools
- TS client (runtime descriptors + encode/decode Any)
- Kong gateway: JWT on MCP route, reflection route open, rate limiting
- Observability: Prometheus (Kong + OTEL hostmetrics), Jaeger traces via OTLP

## One-command deploy
```bash
./deploy.sh
```
This starts Postgres (for Kong), Kong, MCP server, OTEL Collector, Prometheus, Grafana, and Jaeger, then configures routes/plugins. The script prints a JWT to use for calls.

## Call the API
```bash
# Reflection (via Kong gateway - open)
grpcurl -plaintext localhost:8000 list

# List tools via Kong (requires JWT from deploy output)
# Note: Kong JWT authentication may have compatibility issues with grpcurl
grpcurl -plaintext \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -d '{}' \
  localhost:8000 mcp.v0.McpService/ListTools

# Direct MCP server access (no auth required)
grpcurl -plaintext localhost:9443 list
grpcurl -plaintext -d '{}' localhost:9443 mcp.v0.McpService/ListTools
```

## Observability
- Prometheus: `http://localhost:9090` (Targets: kong:8001, otel-collector:8889)
- Grafana: `http://localhost:3000` (admin/admin)
- Jaeger: `http://localhost:16686`

Prometheus queries to try:
- `kong_http_requests_total`
- `histogram_quantile(0.95, sum by (le) (rate(kong_latency_bucket[5m])))`
- `otelcol_receiver_accepted_spans`

## Repo layout
- `proto/mcp/v0/*.proto`, `proto/grpc/reflection/v1alpha/reflection.proto`
- `server/go/*` (demo server, reflection enabled)
- `client/ts/src/{real_client.ts,reflection.ts,generated/**}`
- `docker-compose.yaml`, `setup-kong.sh`, `deploy.sh`, `otel-collector-config.yaml`, `prometheus.yml`

## Optional: regenerate protobuf code (Buf)
Prereqs: Buf CLI, Go toolchain.
```bash
# Install plugins for Go generation
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

# Install buf (macOS)
brew install bufbuild/buf/buf  # or see buf docs for other OS

# Add Go bin to PATH and generate
export PATH=$PATH:$(go env GOPATH)/bin
buf generate
```
Note: TS code is generated via `es` and `connect-es` plugins; Go code requires the two protoc plugins in your PATH. If you get errors about missing Go packages for reflection.proto, the TypeScript generation should still work.

## Run the demo UI (optional)
```bash
cd client/ui
npm install
npm run build  # Builds both frontend and server
npm run start
# UI server: http://localhost:3001
```
Use the JWT token printed by `./deploy.sh` when connecting via the UI (route: MCP requires JWT; reflection is open).

**Note**: The build step compiles both the TypeScript server (`src/server.ts` → `dist/server.js`) and the React frontend. If you get a "Cannot find module" error, ensure the build step completed successfully.

## Notes & limitations
- No TLS/mTLS (local demo). Reflection is open. Admin ports (8001/8002) exposed locally.
- Metrics from Kong require traffic via 8000; OTEL exporter also exposes host metrics on 8889.

## License
MIT - see [LICENSE](LICENSE).