package conformance

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	weather "github.com/strategific/mcp-grpc/server/go/proto/examples/weather"
	mcpv0 "github.com/strategific/mcp-grpc/server/go/proto/mcp/v0"
)

type ConformanceTest struct {
	name        string
	description string
	test        func(t *testing.T, mcpClient mcpv0.McpServiceClient, weatherClient weather.WeatherServiceClient)
}

var conformanceTests = []ConformanceTest{
	{
		name:        "DiscoveryTest",
		description: "ListTools advertises gRPC metadata for weather tools",
		test:        testDiscovery,
	},
	{
		name:        "WeatherUnarySuccess",
		description: "Direct GetWeather RPC returns expected stub response",
		test:        testWeatherSuccess,
	},
	{
		name:        "WeatherValidationFailure",
		description: "GetWeather enforces required fields",
		test:        testWeatherValidationFailure,
	},
	{
		name:        "ForecastDateValidation",
		description: "GetWeatherForecast rejects past or same-day dates",
		test:        testForecastValidation,
	},
}

func TestConformance(t *testing.T) {
	conn, mcpClient, weatherClient := setupTestClients(t)
	t.Cleanup(func() { conn.Close() })

	for _, test := range conformanceTests {
		t.Run(test.name, func(t *testing.T) {
			t.Log(test.description)
			test.test(t, mcpClient, weatherClient)
		})
	}
}

func setupTestClients(t *testing.T) (*grpc.ClientConn, mcpv0.McpServiceClient, weather.WeatherServiceClient) {
	conn, err := grpc.Dial("localhost:8443", grpc.WithTransportCredentials(insecure.NewCredentials()))
	require.NoError(t, err)

	return conn, mcpv0.NewMcpServiceClient(conn), weather.NewWeatherServiceClient(conn)
}

func testDiscovery(t *testing.T, client mcpv0.McpServiceClient, _ weather.WeatherServiceClient) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	resp, err := client.ListTools(ctx, &mcpv0.ListToolsRequest{})
	require.NoError(t, err)

	assert.Greater(t, len(resp.Tools), 0)

	for _, tool := range resp.Tools {
		assert.NotEmpty(t, tool.Name)
		assert.NotEmpty(t, tool.InputType)
		assert.NotEmpty(t, tool.OutputType)
		assert.Contains(t, tool.InputType, ".")
		assert.Contains(t, tool.OutputType, ".")
	}

	var weatherTool *mcpv0.Tool
	for _, tool := range resp.Tools {
		if tool.Name == "get_weather" {
			weatherTool = tool
			break
		}
	}

	require.NotNil(t, weatherTool, "get_weather tool must be advertised")
	assert.Equal(t, "examples.weather.GetWeatherRequest", weatherTool.InputType)
	assert.Equal(t, "examples.weather.GetWeatherResponse", weatherTool.OutputType)
	assert.Equal(t, "examples.weather.WeatherService", weatherTool.GrpcService)
	assert.Equal(t, "GetWeather", weatherTool.GrpcMethod)
}

func testWeatherSuccess(t *testing.T, _ mcpv0.McpServiceClient, client weather.WeatherServiceClient) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	resp, err := client.GetWeather(ctx, &weather.GetWeatherRequest{Location: "San Francisco", Units: "metric"})
	require.NoError(t, err)
	assert.Equal(t, "Partly cloudy", resp.Conditions)
	assert.True(t, resp.TemperatureC > 0)
}

func testWeatherValidationFailure(t *testing.T, _ mcpv0.McpServiceClient, client weather.WeatherServiceClient) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err := client.GetWeather(ctx, &weather.GetWeatherRequest{Location: "", Units: "metric"})
	require.Error(t, err)
	st, ok := status.FromError(err)
	require.True(t, ok)
	assert.Equal(t, codes.InvalidArgument, st.Code())
	assert.Contains(t, st.Message(), "location")
}

func testForecastValidation(t *testing.T, _ mcpv0.McpServiceClient, client weather.WeatherServiceClient) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err := client.GetWeatherForecast(ctx, &weather.GetWeatherForecastRequest{
		Location: "San Francisco",
		Date:     time.Now().Add(-24 * time.Hour).Format("2006-01-02"),
	})
	require.Error(t, err)
	st, ok := status.FromError(err)
	require.True(t, ok)
	assert.Equal(t, codes.InvalidArgument, st.Code())
	assert.Contains(t, st.Message(), "past")
}
