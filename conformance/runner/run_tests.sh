#!/bin/bash
set -e

echo "Starting MCP gRPC Conformance Tests"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Default values
SERVER_ADDRESS="localhost:8443"
TIMEOUT="30s"
VERBOSE=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --server-address)
      SERVER_ADDRESS="$2"
      shift 2
      ;;
    --timeout)
      TIMEOUT="$2"
      shift 2
      ;;
    --verbose)
      VERBOSE=true
      shift
      ;;
    --help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --server-address  Server address (default: localhost:8443)"
      echo "  --timeout         Test timeout (default: 30s)"
      echo "  --verbose         Enable verbose output"
      echo "  --help           Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option $1"
      exit 1
      ;;
  esac
done

echo "Configuration:"
echo "  Server Address: $SERVER_ADDRESS"
echo "  Timeout: $TIMEOUT"
echo "  Verbose: $VERBOSE"
echo ""

# Check if server is running
echo -e "${YELLOW}Checking server connectivity...${NC}"
if ! nc -z "${SERVER_ADDRESS%:*}" "${SERVER_ADDRESS#*:}" 2>/dev/null; then
    echo -e "${RED}ERROR: Cannot connect to server at $SERVER_ADDRESS${NC}"
    echo "Please ensure the MCP server is running"
    exit 1
fi
echo -e "${GREEN}Server is reachable${NC}"

# Set test environment variables
export MCP_SERVER_ADDRESS="$SERVER_ADDRESS"
export MCP_TEST_TIMEOUT="$TIMEOUT"

# Run conformance tests
echo -e "${YELLOW}Running conformance tests...${NC}"

if [ "$VERBOSE" = true ]; then
    go test -v -timeout="$TIMEOUT" ./...
else
    go test -timeout="$TIMEOUT" ./...
fi

TEST_EXIT_CODE=$?

# Run benchmarks
echo ""
echo -e "${YELLOW}Running performance benchmarks...${NC}"

if [ "$VERBOSE" = true ]; then
    go test -bench=. -benchmem -timeout="$TIMEOUT" ./...
else
    go test -bench=. -timeout="$TIMEOUT" ./...
fi

BENCH_EXIT_CODE=$?

# Summary
echo ""
echo "========================================="
echo "           Test Summary"
echo "========================================="

if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}✓ Conformance tests: PASSED${NC}"
else
    echo -e "${RED}✗ Conformance tests: FAILED${NC}"
fi

if [ $BENCH_EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}✓ Benchmarks: COMPLETED${NC}"
else
    echo -e "${RED}✗ Benchmarks: FAILED${NC}"
fi

# Exit with error if any tests failed
if [ $TEST_EXIT_CODE -ne 0 ] || [ $BENCH_EXIT_CODE -ne 0 ]; then
    exit 1
fi

echo -e "${GREEN}All tests completed successfully!${NC}"