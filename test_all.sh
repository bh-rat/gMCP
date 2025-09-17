#!/bin/bash

echo "🧪 Running End-to-End MCP gRPC Tests"
echo "====================================="

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Set PATH to include Go bin
export PATH=$PATH:$(go env GOPATH)/bin

echo -e "${YELLOW}1. Testing server health...${NC}"
if nc -z localhost 8443; then
    echo -e "${GREEN}✅ Server is running on port 8443${NC}"
else
    echo -e "${RED}❌ Server is not running${NC}"
    exit 1
fi

echo -e "${YELLOW}2. Testing gRPC reflection...${NC}"
SERVICES=$(grpcurl -plaintext localhost:8443 list 2>/dev/null)
if echo "$SERVICES" | grep -q "mcp.v0.McpService"; then
    echo -e "${GREEN}✅ MCP service is available${NC}"
else
    echo -e "${RED}❌ MCP service not found${NC}"
    exit 1
fi

echo -e "${YELLOW}3. Testing ListTools...${NC}"
TOOLS_RESPONSE=$(grpcurl -plaintext -d '{}' localhost:8443 mcp.v0.McpService/ListTools 2>/dev/null)
if echo "$TOOLS_RESPONSE" | grep -q "get_weather"; then
    echo -e "${GREEN}✅ ListTools working - found get_weather tool${NC}"
else
    echo -e "${RED}❌ ListTools failed${NC}"
    exit 1
fi

echo -e "${YELLOW}4. Testing CallTool with valid request...${NC}"
CALL_RESPONSE=$(grpcurl -plaintext -d '{
  "name": "get_weather",
  "typedArguments": {
    "@type": "type.googleapis.com/examples.weather.GetWeatherRequest",
    "location": "Toronto",
    "units": "metric"
  },
  "requestId": "test-123"
}' localhost:8443 mcp.v0.McpService/CallTool 2>/dev/null)

if echo "$CALL_RESPONSE" | grep -q "temperatureC"; then
    echo -e "${GREEN}✅ CallTool working - received weather data${NC}"
else
    echo -e "${RED}❌ CallTool failed${NC}"
    exit 1
fi

echo -e "${YELLOW}5. Testing error handling...${NC}"
ERROR_RESPONSE=$(grpcurl -plaintext -d '{"name": "unknown_tool"}' localhost:8443 mcp.v0.McpService/CallTool 2>/dev/null)
if echo "$ERROR_RESPONSE" | grep -q "NOT_FOUND"; then
    echo -e "${GREEN}✅ Error handling working - got NOT_FOUND for unknown tool${NC}"
else
    echo -e "${RED}❌ Error handling failed${NC}"
    exit 1
fi

echo -e "${YELLOW}6. Testing TypeScript client...${NC}"
cd client/ts
TS_OUTPUT=$(timeout 10s npm run dev 2>&1)
if echo "$TS_OUTPUT" | grep -q "All tests completed successfully"; then
    echo -e "${GREEN}✅ TypeScript client working${NC}"
else
    echo -e "${RED}❌ TypeScript client failed${NC}"
    echo "$TS_OUTPUT"
    exit 1
fi

echo ""
echo -e "${GREEN}🎉 ALL TESTS PASSED!${NC}"
echo ""
echo "Summary of successful tests:"
echo "✅ Server health check"
echo "✅ gRPC service discovery"
echo "✅ Tool discovery (ListTools)"
echo "✅ Tool invocation (CallTool)"
echo "✅ Error handling"
echo "✅ TypeScript client integration"
echo ""
echo "The MCP gRPC implementation is working correctly!"