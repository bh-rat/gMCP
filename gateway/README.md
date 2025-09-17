# Kong Gateway Configuration

This directory contains the Kong gateway configuration for the MCP gRPC service.

## Features

- **Authentication**: JWT or mTLS
- **Rate Limiting**: Per-consumer limits
- **Observability**: OpenTelemetry traces and Prometheus metrics
- **TLS Termination**: Secure upstream communication
- **gRPC Routing**: Native gRPC protocol support

## Deployment

### Docker

```bash
docker run -d --name kong \
  -p 8000:8000 -p 8443:8443 \
  -e KONG_DATABASE=off \
  -e KONG_DECLARATIVE_CONFIG=/kong/declarative/kong.yaml \
  -v $PWD/kong.yaml:/kong/declarative/kong.yaml \
  kong:3
```

### Kubernetes

```bash
kubectl apply -f kong.yaml
```

## Configuration

The configuration includes:

- **Service**: `mcp-weather` pointing to the Go server
- **Route**: gRPC routes for `/mcp.v0.McpService/`
- **Plugins**: JWT auth, rate limiting, observability

## Security

- TLS/mTLS termination at the edge
- JWT token validation
- Per-consumer rate limiting
- Upstream certificate verification