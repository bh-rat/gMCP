package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"time"

	mcpv0 "mcp-server/mcp/v0"
	weather "mcp-server/proto/weather"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/reflection"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"
)

type weatherService struct {
	weather.UnimplementedWeatherServiceServer
}

func (s *weatherService) GetWeather(ctx context.Context, req *weather.GetWeatherRequest) (*weather.GetWeatherResponse, error) {
	if req.GetLocation() == "" {
		return nil, status.Error(codes.InvalidArgument, "location is required")
	}

	return &weather.GetWeatherResponse{
		TemperatureC: 22.5,
		Conditions:   "Partly cloudy",
		Humidity:     65,
	}, nil
}

func (s *weatherService) GetWeatherForecast(ctx context.Context, req *weather.GetWeatherForecastRequest) (*weather.GetWeatherForecastResponse, error) {
	if req.GetLocation() == "" {
		return nil, status.Error(codes.InvalidArgument, "location is required")
	}

	if err := validateForecastDate(req.GetDate()); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}

	return &weather.GetWeatherForecastResponse{
		TemperatureC: 24.8,
		Conditions:   "Sunny with light clouds",
		Humidity:     58,
		Date:         req.GetDate(),
		Location:     req.GetLocation(),
	}, nil
}

type simpleService struct {
	mcpv0.UnimplementedMcpServiceServer
}

func (s *simpleService) ListTools(ctx context.Context, req *mcpv0.ListToolsRequest) (*mcpv0.ListToolsResponse, error) {
	weatherSvc := weather.File_weather_weather_proto.Services().ByName("WeatherService")
	weatherServiceName := "examples.weather.WeatherService"
	if weatherSvc != nil {
		weatherServiceName = string(weatherSvc.FullName())
	}

	getWeatherInput := string((&weather.GetWeatherRequest{}).ProtoReflect().Descriptor().FullName())
	getWeatherOutput := string((&weather.GetWeatherResponse{}).ProtoReflect().Descriptor().FullName())
	getForecastInput := string((&weather.GetWeatherForecastRequest{}).ProtoReflect().Descriptor().FullName())
	getForecastOutput := string((&weather.GetWeatherForecastResponse{}).ProtoReflect().Descriptor().FullName())

	tools := []*mcpv0.Tool{
		{
			Name:        "get_weather",
			Title:       "Get Weather",
			Description: "Get current weather conditions for a location",
			InputType:   getWeatherInput,
			OutputType:  getWeatherOutput,
			GrpcService: weatherServiceName,
			GrpcMethod:  "GetWeather",
			Annotations: map[string]string{"idempotent": "true"},
		},
		{
			Name:        "get_weather_forecast",
			Title:       "Get Weather Forecast",
			Description: "Get weather forecast for a future date. Use get_weather for today's weather.",
			InputType:   getForecastInput,
			OutputType:  getForecastOutput,
			GrpcService: weatherServiceName,
			GrpcMethod:  "GetWeatherForecast",
			Annotations: map[string]string{"idempotent": "true"},
		},
	}

	for _, t := range tools {
		log.Printf("ListTools -> %#v", t)
	}

	return &mcpv0.ListToolsResponse{Tools: tools}, nil
}

func validateForecastDate(dateStr string) error {
	if dateStr == "" {
		return fmt.Errorf("date is required")
	}

	inputDate, err := time.Parse("2006-01-02", dateStr)
	if err != nil {
		return fmt.Errorf("invalid date format. Please use YYYY-MM-DD format")
	}

	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	inputDateOnly := time.Date(inputDate.Year(), inputDate.Month(), inputDate.Day(), 0, 0, 0, 0, inputDate.Location())

	if inputDateOnly.Before(today) {
		return fmt.Errorf("cannot get forecast for past dates. Date %s is in the past", dateStr)
	}

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
	weatherSvc := &weatherService{}
	svc := &simpleService{}

	weather.RegisterWeatherServiceServer(s, weatherSvc)
	mcpv0.RegisterMcpServiceServer(s, svc)
	reflection.Register(s)

	log.Printf("MCP Server listening on :8443")
	log.Fatal(s.Serve(lis))
}

func registerServerMeta() {
	sid := os.Getenv("MCP_SERVER_ID")
	if sid == "" {
		sid = "mcp-weather"
	}
	ver := os.Getenv("MCP_SERVER_VERSION")
	if ver == "" {
		ver = "1.0.0"
	}

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
