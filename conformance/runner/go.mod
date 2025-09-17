module github.com/strategific/mcp-grpc/conformance/runner

go 1.21

require (
	github.com/strategific/mcp-grpc/server/go v0.0.0
	github.com/stretchr/testify v1.8.4
	google.golang.org/grpc v1.59.0
	google.golang.org/protobuf v1.31.0
)

replace github.com/strategific/mcp-grpc/server/go => ../../server/go