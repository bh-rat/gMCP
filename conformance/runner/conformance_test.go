package conformance

import (
	"context"
	"crypto/tls"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/anypb"

	mcpv0 "github.com/strategific/mcp-grpc/server/go/proto/mcp/v0"
	weather "github.com/strategific/mcp-grpc/server/go/proto/examples/weather"
)

type ConformanceTest struct {
	name        string
	description string
	test        func(t *testing.T, client mcpv0.McpServiceClient)
}

var conformanceTests = []ConformanceTest{
	{
		name:        "DiscoveryTest",
		description: "Test that ListTools returns accurate tool definitions",
		test:        testDiscovery,
	},
	{
		name:        "UnknownToolTest",
		description: "Test that unknown tools return NOT_FOUND error",
		test:        testUnknownTool,
	},
	{
		name:        "TypeUrlMismatchTest",
		description: "Test that type_url mismatches return INVALID_ARGUMENT",
		test:        testTypeUrlMismatch,
	},
	{
		name:        "ValidationFailureTest",
		description: "Test that PGV failures return INVALID_ARGUMENT",
		test:        testValidationFailure,
	},
	{
		name:        "SizeLimitsTest",
		description: "Test that size limits are enforced",
		test:        testSizeLimits,
	},
	{
		name:        "ChunkingTest",
		description: "Test proper chunking behavior with final=true",
		test:        testChunking,
	},
	{
		name:        "VersioningTest",
		description: "Test that server version changes invalidate cache",
		test:        testVersioning,
	},
}

func TestConformance(t *testing.T) {
	// Setup client connection
	client := setupTestClient(t)

	for _, test := range conformanceTests {
		t.Run(test.name, func(t *testing.T) {
			t.Log(test.description)
			test.test(t, client)
		})
	}
}

func setupTestClient(t *testing.T) mcpv0.McpServiceClient {
	// Connect to test server (assumes server is running)
	creds := credentials.NewTLS(&tls.Config{InsecureSkipVerify: true})
	conn, err := grpc.Dial("localhost:8443", grpc.WithTransportCredentials(creds))
	require.NoError(t, err)

	t.Cleanup(func() {
		conn.Close()
	})

	return mcpv0.NewMcpServiceClient(conn)
}

func testDiscovery(t *testing.T, client mcpv0.McpServiceClient) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	resp, err := client.ListTools(ctx, &mcpv0.ListToolsRequest{})
	require.NoError(t, err)

	// Should have at least one tool
	assert.Greater(t, len(resp.Tools), 0)

	// Check tool structure
	for _, tool := range resp.Tools {
		assert.NotEmpty(t, tool.Name, "Tool name should not be empty")
		assert.NotEmpty(t, tool.InputType, "Input type should not be empty")
		assert.NotEmpty(t, tool.OutputType, "Output type should not be empty")

		// Check fully-qualified type names
		assert.Contains(t, tool.InputType, ".", "Input type should be fully-qualified")
		assert.Contains(t, tool.OutputType, ".", "Output type should be fully-qualified")
	}

	// Check for weather tool specifically
	var weatherTool *mcpv0.Tool
	for _, tool := range resp.Tools {
		if tool.Name == "get_weather" {
			weatherTool = tool
			break
		}
	}

	require.NotNil(t, weatherTool, "Should have get_weather tool")
	assert.Equal(t, "examples.weather.GetWeatherRequest", weatherTool.InputType)
	assert.Equal(t, "examples.weather.GetWeatherResponse", weatherTool.OutputType)
}

func testUnknownTool(t *testing.T, client mcpv0.McpServiceClient) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Create request for non-existent tool
	req := &mcpv0.ToolCallRequest{
		Name:      "nonexistent_tool",
		RequestId: "test_unknown",
	}

	stream, err := client.CallTool(ctx, req)
	require.NoError(t, err)

	// Should get error chunk
	chunk, err := stream.Recv()
	require.NoError(t, err)

	assert.True(t, chunk.Final, "Error chunk should have final=true")
	assert.NotNil(t, chunk.GetError(), "Should have error payload")
	assert.Equal(t, mcpv0.ToolError_NOT_FOUND, chunk.GetError().Code)
}

func testTypeUrlMismatch(t *testing.T, client mcpv0.McpServiceClient) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Create Any with wrong type URL
	wrongAny := &anypb.Any{
		TypeUrl: "type.googleapis.com/wrong.Type",
		Value:   []byte("invalid"),
	}

	req := &mcpv0.ToolCallRequest{
		Name:            "get_weather",
		TypedArguments:  wrongAny,
		RequestId:       "test_type_mismatch",
	}

	stream, err := client.CallTool(ctx, req)
	require.NoError(t, err)

	chunk, err := stream.Recv()
	require.NoError(t, err)

	assert.True(t, chunk.Final)
	assert.NotNil(t, chunk.GetError())
	assert.Equal(t, mcpv0.ToolError_INVALID_ARGUMENT, chunk.GetError().Code)
	assert.Contains(t, chunk.GetError().Message, "type_url")
}

func testValidationFailure(t *testing.T, client mcpv0.McpServiceClient) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Create invalid weather request (empty location violates PGV rules)
	invalidReq := &weather.GetWeatherRequest{
		Location: "", // Invalid: min_len=1
		Units:    "metric",
	}

	any, err := anypb.New(invalidReq)
	require.NoError(t, err)

	req := &mcpv0.ToolCallRequest{
		Name:           "get_weather",
		TypedArguments: any,
		RequestId:      "test_validation",
	}

	stream, err := client.CallTool(ctx, req)
	require.NoError(t, err)

	chunk, err := stream.Recv()
	require.NoError(t, err)

	assert.True(t, chunk.Final)
	assert.NotNil(t, chunk.GetError())
	assert.Equal(t, mcpv0.ToolError_INVALID_ARGUMENT, chunk.GetError().Code)
	assert.Contains(t, chunk.GetError().Message, "validation")
}

func testSizeLimits(t *testing.T, client mcpv0.McpServiceClient) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Create oversized request (assuming 1MB limit)
	oversizedReq := &weather.GetWeatherRequest{
		Location: string(make([]byte, 2*1024*1024)), // 2MB location
		Units:    "metric",
	}

	any, err := anypb.New(oversizedReq)
	require.NoError(t, err)

	req := &mcpv0.ToolCallRequest{
		Name:           "get_weather",
		TypedArguments: any,
		RequestId:      "test_size_limit",
	}

	stream, err := client.CallTool(ctx, req)
	require.NoError(t, err)

	chunk, err := stream.Recv()
	require.NoError(t, err)

	assert.True(t, chunk.Final)
	assert.NotNil(t, chunk.GetError())
	assert.Equal(t, mcpv0.ToolError_INVALID_ARGUMENT, chunk.GetError().Code)
	assert.Contains(t, chunk.GetError().Message, "large")
}

func testChunking(t *testing.T, client mcpv0.McpServiceClient) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Create valid weather request
	validReq := &weather.GetWeatherRequest{
		Location: "Toronto",
		Units:    "metric",
	}

	any, err := anypb.New(validReq)
	require.NoError(t, err)

	req := &mcpv0.ToolCallRequest{
		Name:           "get_weather",
		TypedArguments: any,
		RequestId:      "test_chunking",
	}

	stream, err := client.CallTool(ctx, req)
	require.NoError(t, err)

	var chunks []*mcpv0.ToolCallChunk
	finalReceived := false

	for {
		chunk, err := stream.Recv()
		if err != nil {
			break
		}

		chunks = append(chunks, chunk)

		// Check sequence numbers
		assert.Equal(t, uint32(len(chunks)-1), chunk.Seq, "Sequence numbers should increment from 0")

		if chunk.Final {
			finalReceived = true
			break
		}

		// Non-final chunks should have results
		if !chunk.Final {
			assert.NotNil(t, chunk.GetResult(), "Non-final chunks should have results")
		}
	}

	assert.True(t, finalReceived, "Should receive exactly one final=true chunk")
	assert.Greater(t, len(chunks), 0, "Should receive at least one chunk")

	// Last chunk should have final=true
	lastChunk := chunks[len(chunks)-1]
	assert.True(t, lastChunk.Final, "Last chunk should have final=true")

	// Check that we got valid weather data
	if len(chunks) > 1 || (len(chunks) == 1 && chunks[0].GetResult() != nil) {
		// Should have at least one result chunk
		hasResult := false
		for _, chunk := range chunks {
			if chunk.GetResult() != nil {
				hasResult = true

				// Unpack and verify weather response
				weatherResp := &weather.GetWeatherResponse{}
				err := chunk.GetResult().UnmarshalTo(weatherResp)
				assert.NoError(t, err)
				assert.NotEmpty(t, weatherResp.Conditions)
			}
		}
		assert.True(t, hasResult, "Should have at least one result chunk")
	}
}

func testVersioning(t *testing.T, client mcpv0.McpServiceClient) {
	// This test would require server restart with different version
	// For now, just verify that we can extract version info from descriptors

	// This would be implemented by:
	// 1. Getting current descriptors via reflection
	// 2. Extracting server_version from FileOptions
	// 3. Verifying it matches expected format

	t.Skip("Versioning test requires server restart - implement in integration tests")
}

// Benchmark tests for performance validation
func BenchmarkListTools(b *testing.B) {
	client := setupBenchClient(b)
	ctx := context.Background()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := client.ListTools(ctx, &mcpv0.ListToolsRequest{})
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkCallTool(b *testing.B) {
	client := setupBenchClient(b)
	ctx := context.Background()

	// Prepare request
	validReq := &weather.GetWeatherRequest{
		Location: "Toronto",
		Units:    "metric",
	}
	any, _ := anypb.New(validReq)
	req := &mcpv0.ToolCallRequest{
		Name:           "get_weather",
		TypedArguments: any,
		RequestId:      "bench",
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		stream, err := client.CallTool(ctx, req)
		if err != nil {
			b.Fatal(err)
		}

		// Consume all chunks
		for {
			_, err := stream.Recv()
			if err != nil {
				break
			}
		}
	}
}

func setupBenchClient(b *testing.B) mcpv0.McpServiceClient {
	creds := credentials.NewTLS(&tls.Config{InsecureSkipVerify: true})
	conn, err := grpc.Dial("localhost:8443", grpc.WithTransportCredentials(creds))
	if err != nil {
		b.Fatal(err)
	}

	b.Cleanup(func() {
		conn.Close()
	})

	return mcpv0.NewMcpServiceClient(conn)
}