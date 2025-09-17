#!/bin/bash

set -e

echo "🚀 MCP Kong Gateway Full Stack Deployment"
echo "=========================================="

echo "1. Starting database..."
docker compose up -d kong-database

echo "2. Waiting for database..."
sleep 10

echo "3. Bootstrapping Kong database..."
docker compose run --rm kong kong migrations bootstrap

echo "4. Starting all services..."
docker compose up -d

echo "5. Waiting for services to be ready..."
sleep 30

echo "6. Setting up Kong configuration..."
./setup-kong.sh

echo ""
echo "🎉 Full Stack Deployed Successfully!"
echo ""
echo "🌐 Service URLs:"
echo "  Kong Gateway:     http://localhost:8000 (requires JWT)"
echo "  Kong Admin API:   http://localhost:8001"
echo "  Kong Admin GUI:   http://localhost:8002"
echo "  MCP Server:       http://localhost:9443 (direct)"
echo "  Prometheus:       http://localhost:9090"
echo "  Grafana:          http://localhost:3000 (admin/admin)"
echo "  Jaeger:           http://localhost:16686"
echo ""
echo "🧪 Run Tests:"
echo "  cd client/ts && npm install && npm run test-gateway"
echo ""
echo "🔍 Kong Admin GUI Guide:"
echo "  1. Go to http://localhost:8002"
echo "  2. Check 'Services' - you should see 'mcp-service'"
echo "  3. Check 'Routes' - you should see the gRPC route"
echo "  4. Check 'Consumers' - you should see 'test-client'"
echo "  5. Check 'Plugins' - you should see jwt, rate-limiting, opentelemetry, prometheus"
echo ""
echo "📊 Observability Guide:"
echo "  Prometheus: Go to http://localhost:9090, query 'kong_http_requests_total'"
echo "  Grafana: Go to http://localhost:3000, explore Kong and OTEL dashboards"
echo "  Jaeger: Go to http://localhost:16686, search for 'kong-gateway' service traces"
echo ""
echo "🛑 To stop all services:"
echo "  docker compose down"