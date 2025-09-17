export { RealMcpClient as McpClient } from './real_client';
export { DescriptorCache, ServerMeta, DescriptorInfo } from './reflection';

// Re-export generated types for convenience
export * from './generated/mcp/v0/mcp_pb';
export * from './generated/mcp/v0/server_meta_pb';