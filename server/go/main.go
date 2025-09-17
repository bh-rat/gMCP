package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"time"

	mcpv0 "mcp-server/mcp/v0"
	weather "mcp-server/proto"

	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/known/anypb"
)

// Simple service implementation for testing
type simpleService struct {
	mcpv0.UnimplementedMcpServiceServer
}

func (s *simpleService) ListTools(ctx context.Context, req *mcpv0.ListToolsRequest) (*mcpv0.ListToolsResponse, error) {
	tools := []*mcpv0.Tool{
		{
			Name:        "get_weather",
			Title:       "Get Weather",
			Description: "Get current weather conditions for a location",
			InputType:   "weather.GetWeatherRequest",
			OutputType:  "weather.GetWeatherResponse",
			Annotations: map[string]string{"idempotent": "true"},
		},
		{
			Name:        "get_weather_forecast",
			Title:       "Get Weather Forecast",
			Description: "Get weather forecast for a future date. Use get_weather for today's weather.",
			InputType:   "weather.GetWeatherForecastRequest",
			OutputType:  "weather.GetWeatherForecastResponse",
			Annotations: map[string]string{"idempotent": "true"},
		},
	}

	return &mcpv0.ListToolsResponse{
		Tools: tools,
	}, nil
}

func (s *simpleService) CallTool(req *mcpv0.ToolCallRequest, stream mcpv0.McpService_CallToolServer) error {
	switch req.Name {
	case "get_weather":
		return s.handleGetWeather(req, stream)
	case "get_weather_forecast":
		return s.handleGetWeatherForecast(req, stream)
	default:
		return stream.Send(&mcpv0.ToolCallChunk{
			Payload: &mcpv0.ToolCallChunk_Error{
				Error: &mcpv0.ToolError{
					Code:    mcpv0.ToolError_NOT_FOUND,
					Message: "unknown tool",
				},
			},
			Seq:   0,
			Final: true,
		})
	}
}

func (s *simpleService) handleGetWeather(req *mcpv0.ToolCallRequest, stream mcpv0.McpService_CallToolServer) error {
	// Create mock weather response
	response := &weather.GetWeatherResponse{
		TemperatureC: 22.5,
		Conditions:   "Partly cloudy",
		Humidity:     65,
	}

	any, err := anypb.New(response)
	if err != nil {
		return stream.Send(&mcpv0.ToolCallChunk{
			Payload: &mcpv0.ToolCallChunk_Error{
				Error: &mcpv0.ToolError{
					Code:    mcpv0.ToolError_INTERNAL,
					Message: "failed to pack response",
				},
			},
			Seq:   0,
			Final: true,
		})
	}

	// Send result chunk
	if err := stream.Send(&mcpv0.ToolCallChunk{
		Payload: &mcpv0.ToolCallChunk_Result{Result: any},
		Seq:     0,
		Final:   false,
	}); err != nil {
		return err
	}

	// Send final chunk
	return stream.Send(&mcpv0.ToolCallChunk{
		Seq:   1,
		Final: true,
	})
}

func (s *simpleService) handleGetWeatherForecast(req *mcpv0.ToolCallRequest, stream mcpv0.McpService_CallToolServer) error {
	// Parse the request to get the forecast request
	var forecastReq weather.GetWeatherForecastRequest
	if err := req.TypedArguments.UnmarshalTo(&forecastReq); err != nil {
		return stream.Send(&mcpv0.ToolCallChunk{
			Payload: &mcpv0.ToolCallChunk_Error{
				Error: &mcpv0.ToolError{
					Code:    mcpv0.ToolError_INVALID_ARGUMENT,
					Message: fmt.Sprintf("failed to parse request: %v", err),
				},
			},
			Seq:   0,
			Final: true,
		})
	}

	// Validate the date
	if err := s.validateForecastDate(forecastReq.Date); err != nil {
		return stream.Send(&mcpv0.ToolCallChunk{
			Payload: &mcpv0.ToolCallChunk_Error{
				Error: &mcpv0.ToolError{
					Code:    mcpv0.ToolError_INVALID_ARGUMENT,
					Message: err.Error(),
				},
			},
			Seq:   0,
			Final: true,
		})
	}

	// Create mock forecast response
	response := &weather.GetWeatherForecastResponse{
		TemperatureC: 24.8,
		Conditions:   "Sunny with light clouds",
		Humidity:     58,
		Date:         forecastReq.Date,
		Location:     forecastReq.Location,
	}

	any, err := anypb.New(response)
	if err != nil {
		return stream.Send(&mcpv0.ToolCallChunk{
			Payload: &mcpv0.ToolCallChunk_Error{
				Error: &mcpv0.ToolError{
					Code:    mcpv0.ToolError_INTERNAL,
					Message: "failed to pack response",
				},
			},
			Seq:   0,
			Final: true,
		})
	}

	// Send result chunk
	if err := stream.Send(&mcpv0.ToolCallChunk{
		Payload: &mcpv0.ToolCallChunk_Result{Result: any},
		Seq:     0,
		Final:   false,
	}); err != nil {
		return err
	}

	// Send final chunk
	return stream.Send(&mcpv0.ToolCallChunk{
		Seq:   1,
		Final: true,
	})
}

func (s *simpleService) validateForecastDate(dateStr string) error {
	if dateStr == "" {
		return fmt.Errorf("date is required")
	}

	// Parse the date in YYYY-MM-DD format
	inputDate, err := time.Parse("2006-01-02", dateStr)
	if err != nil {
		return fmt.Errorf("invalid date format. Please use YYYY-MM-DD format")
	}

	// Get current date (without time)
	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	inputDateOnly := time.Date(inputDate.Year(), inputDate.Month(), inputDate.Day(), 0, 0, 0, 0, inputDate.Location())

	// Check if date is in the past
	if inputDateOnly.Before(today) {
		return fmt.Errorf("cannot get forecast for past dates. Date %s is in the past", dateStr)
	}

	// Check if date is today
	if inputDateOnly.Equal(today) {
		return fmt.Errorf("for today's weather (%s), please use get_weather tool instead", dateStr)
	}

	return nil
}

func main() {
	// Inject server meta into reflection descriptors so clients can read it
	registerServerMeta()
	lis, err := net.Listen("tcp", ":8443")
	if err != nil {
		log.Fatalf("Failed to listen: %v", err)
	}

	s := grpc.NewServer()
	service := &simpleService{}

	mcpv0.RegisterMcpServiceServer(s, service)
	reflection.Register(s)

	log.Printf("MCP Server listening on :8443")
	log.Fatal(s.Serve(lis))
}

func registerServerMeta() {
  sid := os.Getenv("MCP_SERVER_ID")
  if sid == "" { sid = "mcp-weather" }
  ver := os.Getenv("MCP_SERVER_VERSION")
  if ver == "" { ver = "1.0.0" }

  fdp := &descriptorpb.FileDescriptorProto{
    Name:       proto.String("internal/meta_anchor.proto"),
    Package:    proto.String("mcp.v0.meta"),
    Dependency: []string{"mcp/v0/server_meta.proto"},
    Options:    &descriptorpb.FileOptions{},
  }
  proto.SetExtension(fdp.Options, mcpv0.E_McpServerMeta, &mcpv0.ServerMeta{
    ServerId: sid, ServerVersion: ver,
  })

  // Build a file descriptor and register it so reflection can serve it
  fd, err := protodesc.NewFile(fdp, protoregistry.GlobalFiles)
  if err != nil {
    log.Printf("meta descriptor build failed: %v", err)
    return
  }
  err = protoregistry.GlobalFiles.RegisterFile(fd)
  if err != nil {
    log.Printf("failed to register file descriptor: %v", err)
  }
}