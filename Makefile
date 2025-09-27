.PHONY: help generate build test lint clean server client conformance

# Default target
help:
	@echo "Available targets:"
	@echo "  generate    - Generate code from protobuf definitions"
	@echo "  build       - Build all components"
	@echo "  test        - Run all tests"
	@echo "  lint        - Lint protobuf files"
	@echo "  clean       - Clean generated files"
	@echo "  server      - Run the Go server"
	@echo "  client      - Run the TypeScript client example"
	@echo "  conformance - Run conformance tests"
	@echo "  kong        - Start Kong gateway with Docker"

# Generate code from protobuf definitions
generate:
	@echo "Generating code from protobuf definitions..."
	buf generate --template buf.gen.yaml

# Build all components
build: generate
	@echo "Building Go server..."
	cd server/go && go build ./cmd/mcp-weather
	@echo "Building TypeScript client..."
	cd client/ts && npm run build

# Run all tests
test:
	@echo "Running Go tests..."
	cd server/go && go test ./...
	@echo "Running TypeScript tests..."
	cd client/ts && npm test || true
	@echo "Running conformance tests..."
	cd conformance && ./runner/run_tests.sh || true

# Lint protobuf files
lint:
	@echo "Linting protobuf files..."
	buf lint

# Clean generated files
clean:
	@echo "Cleaning generated files..."
	rm -rf server/go/proto/
	rm -rf client/ts/src/generated/
	cd server/go && go clean
	cd client/ts && rm -rf dist/

# Run the Go server
server: generate
	@echo "Starting MCP weather server..."
	cd server/go && go run ./cmd/mcp-weather

# Run the TypeScript client example
client:
	@echo "Running TypeScript client example..."
	cd client/ts && npm run dev

# Run conformance tests
conformance:
	@echo "Running conformance tests..."
	cd conformance && ./runner/run_tests.sh

# Start Kong gateway with Docker
kong:
	@echo "Starting Kong gateway..."
	docker run -d --name kong-mcp \
		-p 8000:8000 -p 8443:8443 \
		-e KONG_DATABASE=off \
		-e KONG_DECLARATIVE_CONFIG=/kong/declarative/kong.yaml \
		-v $(PWD)/gateway/kong.yaml:/kong/declarative/kong.yaml \
		kong:3
	@echo "Kong gateway started on ports 8000 (admin) and 8443 (proxy)"

# Stop Kong gateway
kong-stop:
	@echo "Stopping Kong gateway..."
	docker stop kong-mcp || true
	docker rm kong-mcp || true

# Install dependencies
deps:
	@echo "Installing Go dependencies..."
	cd server/go && go mod tidy
	cd conformance/runner && go mod tidy
	@echo "Installing TypeScript dependencies..."
	cd client/ts && npm install

# Development setup
setup: deps generate
	@echo "Development environment ready!"
	@echo "Run 'make server' to start the server"
	@echo "Run 'make client' in another terminal to test the client"

# CI target for continuous integration
ci: lint generate build test conformance
	@echo "CI pipeline completed successfully!"
