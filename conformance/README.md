# MCP gRPC Conformance Tests

This directory contains conformance tests for the MCP gRPC protocol implementation.

## Test Coverage

The conformance test suite validates the following scenarios:

### Core Protocol Tests

1. **Discovery Test**: Validates that `ListTools` returns accurate tool definitions with proper type information
2. **Unknown Tool Test**: Ensures unknown tools return `NOT_FOUND` error with `final=true`
3. **Type URL Mismatch Test**: Verifies type_url validation returns `INVALID_ARGUMENT`
4. **Validation Failure Test**: Tests that PGV validation failures return appropriate errors
5. **Size Limits Test**: Confirms input/output size limits are enforced
6. **Chunking Test**: Validates proper streaming behavior with multiple chunks and `final=true`
7. **Versioning Test**: Tests descriptor caching and invalidation on version changes

### Performance Tests

- **ListTools Benchmark**: Measures tool discovery performance
- **CallTool Benchmark**: Measures tool invocation latency and throughput

## Running Tests

### Prerequisites

1. **Server Running**: Ensure an MCP server is running on the target address
2. **Go Environment**: Go 1.21+ installed
3. **Dependencies**: Run `go mod tidy` in the runner directory

### Basic Usage

```bash
# Run with default settings (localhost:8443)
./run_tests.sh

# Run against custom server
./run_tests.sh --server-address my-server:8443

# Run with verbose output
./run_tests.sh --verbose

# Set custom timeout
./run_tests.sh --timeout 60s
```

### Manual Test Execution

```bash
cd conformance/runner

# Run all tests
go test -v ./...

# Run specific test
go test -v -run TestDiscovery ./...

# Run benchmarks
go test -bench=. -benchmem ./...
```

## Test Configuration

Tests can be configured via environment variables:

- `MCP_SERVER_ADDRESS`: Server address (default: localhost:8443)
- `MCP_TEST_TIMEOUT`: Test timeout (default: 30s)

## Test Scenarios

### Positive Tests

#### Valid Tool Call
```go
validReq := &weather.GetWeatherRequest{
    Location: "Toronto",
    Units:    "metric",
}
// Should return weather data with final=true
```

#### Tool Discovery
```go
resp, err := client.ListTools(ctx, &mcpv0.ListToolsRequest{})
// Should return list of available tools with proper schemas
```

### Negative Tests

#### Invalid Input
```go
invalidReq := &weather.GetWeatherRequest{
    Location: "", // Violates min_len=1 PGV rule
    Units:    "metric",
}
// Should return INVALID_ARGUMENT with validation error
```

#### Type Mismatch
```go
wrongAny := &anypb.Any{
    TypeUrl: "type.googleapis.com/wrong.Type",
    Value:   []byte("invalid"),
}
// Should return INVALID_ARGUMENT with type_url error
```

#### Unknown Tool
```go
req := &mcpv0.ToolCallRequest{
    Name: "nonexistent_tool",
}
// Should return NOT_FOUND error
```

## Expected Behaviors

### Chunking Requirements

1. **Sequence Numbers**: Must start at 0 and increment
2. **Final Chunk**: Exactly one chunk with `final=true`
3. **Error Termination**: Error chunks must have `final=true`
4. **Result Chunks**: May have multiple result chunks before final

### Error Handling

1. **Error Codes**: Must use appropriate gRPC error codes
2. **Error Messages**: Should be descriptive but not leak sensitive info
3. **Error Details**: May include structured error details

### Performance Expectations

- **ListTools**: Should complete within 100ms for typical tool counts
- **CallTool**: Should start streaming within 200ms
- **Throughput**: Should handle concurrent calls efficiently

## CI Integration

### GitHub Actions

```yaml
name: Conformance Tests
on: [push, pull_request]

jobs:
  conformance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-go@v4
        with:
          go-version: '1.21'

      - name: Start MCP Server
        run: |
          cd server/go
          go run ./cmd/mcp-weather &
          sleep 5

      - name: Run Conformance Tests
        run: |
          cd conformance
          ./runner/run_tests.sh --timeout 60s
```

### Docker Testing

```bash
# Build server image
docker build -t mcp-server server/go

# Run server
docker run -d --name mcp-server -p 8443:8443 mcp-server

# Run tests
docker run --rm --network host \
  -v $PWD/conformance:/tests \
  golang:1.21 \
  bash -c "cd /tests && ./runner/run_tests.sh"
```

## Troubleshooting

### Common Issues

**Connection Refused**
```bash
# Check if server is running
nc -zv localhost 8443

# Check server logs
docker logs mcp-server
```

**TLS Errors**
```bash
# Test TLS connection
openssl s_client -connect localhost:8443

# Use insecure connection for testing
export MCP_TEST_INSECURE=true
```

**Test Timeouts**
```bash
# Increase timeout
./run_tests.sh --timeout 120s

# Check server performance
go test -bench=. -benchtime=10s
```

### Debug Mode

Enable verbose logging:
```bash
export MCP_TEST_DEBUG=true
./run_tests.sh --verbose
```

This will output detailed request/response information for debugging.

## Adding New Tests

### Test Structure

```go
func testNewScenario(t *testing.T, client mcpv0.McpServiceClient) {
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    // Test implementation
    // Use assert/require for validation
}
```

### Registration

Add to `conformanceTests` slice:
```go
{
    name:        "NewScenarioTest",
    description: "Test description",
    test:        testNewScenario,
}
```

### Best Practices

1. **Isolation**: Each test should be independent
2. **Cleanup**: Use `t.Cleanup()` for resource cleanup
3. **Timeouts**: Always use context with timeout
4. **Assertions**: Use descriptive assertion messages
5. **Coverage**: Test both positive and negative cases