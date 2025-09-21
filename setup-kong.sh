#!/bin/bash

set -e

KONG_ADMIN_URL="http://localhost:8001"

echo "🔧 Setting up Kong Gateway with Full Observability..."

# Wait for Kong to be ready
echo "⏳ Waiting for Kong Admin API..."
while ! curl -s $KONG_ADMIN_URL/status > /dev/null; do
    sleep 2
    echo "Waiting for Kong..."
done

echo "✅ Kong is ready"

# Clean up everything first
echo "🧹 Cleaning up existing MCP configuration..."

# Delete existing routes and services
curl -s -X DELETE $KONG_ADMIN_URL/routes/mcp-grpc-route > /dev/null 2>&1 || true
curl -s -X DELETE $KONG_ADMIN_URL/routes/grpc-reflection > /dev/null 2>&1 || true
curl -s -X DELETE $KONG_ADMIN_URL/routes/weather-grpc-route > /dev/null 2>&1 || true

# Delete any unnamed routes for mcp service
SERVICE_ID=$(curl -s $KONG_ADMIN_URL/services/mcp-service | jq -r '.id' 2>/dev/null || echo "")
if [ -n "$SERVICE_ID" ] && [ "$SERVICE_ID" != "null" ]; then
    ROUTES=$(curl -s $KONG_ADMIN_URL/services/$SERVICE_ID/routes | jq -r '.data[].id' 2>/dev/null || echo "")
    for route_id in $ROUTES; do
        curl -s -X DELETE $KONG_ADMIN_URL/routes/$route_id > /dev/null 2>&1 || true
    done
fi

curl -s -X DELETE $KONG_ADMIN_URL/services/mcp-service > /dev/null 2>&1 || true

# Create MCP Service fresh
echo "🏗️  Creating MCP service..."
SERVICE_RESPONSE=$(curl -s -X POST $KONG_ADMIN_URL/services \
  --data name=mcp-service \
  --data protocol=grpc \
  --data host=mcp-server \
  --data port=8443)

echo "Service response: $SERVICE_RESPONSE"

# Create Route for MCP Service (gRPC) with proper path and no strip
echo "🛣️  Creating MCP route..."
ROUTE_RESPONSE=$(curl -s -X POST $KONG_ADMIN_URL/services/mcp-service/routes \
  --data name=mcp-grpc-route \
  --data 'protocols[]=grpc' \
  --data 'protocols[]=grpcs' \
  --data 'paths[]=/mcp.v0.McpService/' \
  --data strip_path=false)

echo "Route response: $ROUTE_RESPONSE"

# Create Weather Service route for direct RPCs
echo "🛣️  Creating Weather gRPC route..."
WEATHER_ROUTE_RESPONSE=$(curl -s -X POST $KONG_ADMIN_URL/services/mcp-service/routes \
  --data name=weather-grpc-route \
  --data 'protocols[]=grpc' \
  --data 'protocols[]=grpcs' \
  --data 'paths[]=/examples.weather.WeatherService/' \
  --data strip_path=false)

echo "Weather Route response: $WEATHER_ROUTE_RESPONSE"

# Create gRPC Reflection route (no auth)
echo "🛣️  Creating gRPC reflection route..."
REFLECT_ROUTE_RESPONSE=$(curl -s -X POST $KONG_ADMIN_URL/services/mcp-service/routes \
  --data name=grpc-reflection \
  --data 'protocols[]=grpc' \
  --data 'protocols[]=grpcs' \
  --data 'paths[]=/grpc.reflection.v1alpha.ServerReflection/' \
  --data strip_path=false)

echo "Reflection Route response: $REFLECT_ROUTE_RESPONSE"

# Create Consumer for testing (only if doesn't exist)
echo "👤 Creating test consumer..."
if ! curl -s $KONG_ADMIN_URL/consumers/test-client > /dev/null 2>&1; then
  CONSUMER_RESPONSE=$(curl -s -X POST $KONG_ADMIN_URL/consumers \
    --data username=test-client)
  echo "Consumer response: $CONSUMER_RESPONSE"
else
  echo "✅ Consumer test-client already exists"
fi

# Get or create JWT credentials for consumer
echo "🔑 Getting JWT credentials..."
JWT_LIST=$(curl -s $KONG_ADMIN_URL/consumers/test-client/jwt)
JWT_COUNT=$(echo $JWT_LIST | jq -r '.data | length')

if [ "$JWT_COUNT" = "0" ]; then
  echo "Creating new JWT credentials..."
  JWT_RESPONSE=$(curl -s -X POST $KONG_ADMIN_URL/consumers/test-client/jwt \
    --data algorithm=HS256 \
    --data key=test-key)
else
  echo "✅ Using existing JWT credentials"
  JWT_RESPONSE=$(echo $JWT_LIST | jq -r '.data[0]')
fi

JWT_SECRET=$(echo $JWT_RESPONSE | jq -r '.secret')
echo "JWT Secret: $JWT_SECRET"

# Ensure no leftover JWT plugin on service or reflection route
echo "🧹 Removing any JWT plugin bound to service or reflection route..."
SERVICE_JWT_ID=$(curl -s $KONG_ADMIN_URL/services/mcp-service/plugins | jq -r '.data[] | select(.name=="jwt") | .id')
if [ -n "$SERVICE_JWT_ID" ] && [ "$SERVICE_JWT_ID" != "null" ]; then
  curl -s -X DELETE $KONG_ADMIN_URL/plugins/$SERVICE_JWT_ID > /dev/null || true
fi
REFLECT_JWT_ID=$(curl -s $KONG_ADMIN_URL/routes/grpc-reflection/plugins | jq -r '.data[] | select(.name=="jwt") | .id')
if [ -n "$REFLECT_JWT_ID" ] && [ "$REFLECT_JWT_ID" != "null" ]; then
  curl -s -X DELETE $KONG_ADMIN_URL/plugins/$REFLECT_JWT_ID > /dev/null || true
fi

# Enable JWT plugin on the MCP route only (not on reflection)
echo "🔐 Enabling JWT authentication on MCP route..."
curl -s -X POST $KONG_ADMIN_URL/routes/mcp-grpc-route/plugins \
  --data name=jwt \
  --data config.key_claim_name=iss

curl -s -X POST $KONG_ADMIN_URL/routes/weather-grpc-route/plugins \
  --data name=jwt \
  --data config.key_claim_name=iss

# Enable Rate Limiting
echo "⏱️  Enabling rate limiting..."
curl -s -X POST $KONG_ADMIN_URL/services/mcp-service/plugins \
  --data name=rate-limiting \
  --data config.minute=100 \
  --data config.hour=1000

# Enable OpenTelemetry
echo "📊 Enabling OpenTelemetry..."
curl -s -X POST $KONG_ADMIN_URL/services/mcp-service/plugins \
  --data name=opentelemetry \
  --data config.endpoint=http://otel-collector:4317

# Enable Prometheus (ensure detailed metric families are enabled)
echo "📈 Ensuring Prometheus metrics (status/latency/bandwidth/upstream health) ..."
PROM_ID=$(curl -s "$KONG_ADMIN_URL/plugins?name=prometheus" | jq -r '.data[0].id // empty')
if [ -z "$PROM_ID" ] || [ "$PROM_ID" = "null" ]; then
  curl -s -X POST $KONG_ADMIN_URL/plugins \
    --data name=prometheus \
    --data config.status_code_metrics=true \
    --data config.latency_metrics=true \
    --data config.bandwidth_metrics=true \
    --data config.upstream_health_metrics=true > /dev/null
else
  curl -s -X PATCH $KONG_ADMIN_URL/plugins/$PROM_ID \
    --data config.status_code_metrics=true \
    --data config.latency_metrics=true \
    --data config.bandwidth_metrics=true \
    --data config.upstream_health_metrics=true > /dev/null
fi

# Create JWT token for testing
echo "🎟️  Creating test JWT token..."
echo "Installing jsonwebtoken locally..."
npm install jsonwebtoken

echo "Generating JWT token..."
JWT_TOKEN=$(node -e "
const jwt = require('./node_modules/jsonwebtoken');
const token = jwt.sign(
  { iss: 'test-key', sub: 'test-client', exp: Math.floor(Date.now() / 1000) + 3600 },
  \"$JWT_SECRET\"
);
console.log(token);
")

echo ""
echo "🎉 Kong Gateway Setup Complete!"
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
echo "🔑 JWT Token for testing:"
echo "export JWT_TOKEN=\"$JWT_TOKEN\""
echo ""
echo "🧪 Test Commands:"
echo "  cd client/ts && npm install && npm run test-gateway"
