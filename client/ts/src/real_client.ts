import { createGrpcTransport } from "@connectrpc/connect-node";
import { createClient, Interceptor } from "@connectrpc/connect";
import { McpService } from "./generated/mcp/v0/mcp_pb.js";
import { ListToolsRequestSchema, ToolCallRequestSchema, ToolCallChunk, ToolError_Code, Tool } from "./generated/mcp/v0/mcp_pb.js";
import { create as createMessage, toBinary, fromBinary } from "@bufbuild/protobuf";
import { DescriptorCache } from "./reflection";

export class RealMcpClient {
    private client: any;
    private transport: any;
    private descriptors = new DescriptorCache();

    constructor(private address: string, private options?: { metadata?: Record<string, string> }) {}

    async connect(): Promise<void> {
        const headerInterceptor: Interceptor | undefined = this.options?.metadata
            ? (next) => async (req) => {
                for (const [key, value] of Object.entries(this.options!.metadata!)) {
                    req.header.set(key, value);
                }
                return next(req);
            }
            : undefined;

        this.transport = createGrpcTransport({
            baseUrl: `http://${this.address}`,
            interceptors: headerInterceptor ? [headerInterceptor] : []
        });

        this.client = createClient(McpService as any, this.transport);
    }

    async listTools(cursor?: string, pageSize?: number): Promise<any> {
        const request = createMessage(ListToolsRequestSchema, {
            cursor: cursor ?? "",
            pageSize: pageSize ?? 100
        });

        const response = await this.client.listTools(request);
        return {
            success: true,
            tools: (response.tools as Tool[]).map((tool: Tool) => ({
                name: tool.name,
                title: tool.title,
                description: tool.description,
                inputType: tool.inputType,
                outputType: tool.outputType,
                annotations: tool.annotations
            }))
        };
    }

    async callTool(toolName: string, args: any): Promise<any> {
        // Discover tool types
        const { tools } = await this.listTools();
        const tool = tools.find((t: any) => t.name === toolName);
        const inputFqtn = tool?.inputType;
        const outputFqtn = tool?.outputType;

        // Build runtime codec via reflection (best-effort)
        let typedArguments: { typeUrl: string; value: Uint8Array } | undefined;
        let decodeResult: ((anyMsg: { typeUrl?: string; type_url?: string; value: Uint8Array | Buffer }) => any) | null = null;

        try {
            if (inputFqtn || outputFqtn) {
                const root = await this.descriptors.getTypesRoot(this.address, [inputFqtn, outputFqtn].filter(Boolean) as string[]);
                const codec = this.descriptors.buildCodec(root);
                decodeResult = (anyMsg) => codec.decodeAny(anyMsg);

                if (args && inputFqtn && Object.keys(args).length > 0) {
                    typedArguments = codec.encodeToAny(inputFqtn, args);
                }
            }
        } catch (e) {
            // Fallback to JSON Any if reflection fails
        }

        if (!typedArguments && args && Object.keys(args).length > 0) {
            const jsonStr = JSON.stringify(args);
            const encoder = new TextEncoder();
            typedArguments = {
                typeUrl: `type.googleapis.com/json.Args`,
                value: encoder.encode(jsonStr)
            };
        }

        const request = createMessage(ToolCallRequestSchema, {
            name: toolName,
            typedArguments,
            requestId: `req-${Date.now()}`
        });

        const results: any[] = [];

        for await (const chunk of (this.client.callTool(request) as AsyncIterable<ToolCallChunk>)) {
            const result: any = {
                seq: chunk.seq,
                final: chunk.final
            };

            if (chunk.payload.case === "result") {
                const anyMessage = chunk.payload.value as any;
                if (anyMessage?.typeUrl && anyMessage?.value) {
                    try {
                        if (decodeResult) {
                            result.result = decodeResult(anyMessage);
                        } else {
                            result.result = {
                                $typeName: "google.protobuf.Any",
                                typeUrl: anyMessage.typeUrl,
                                value: this.tryDecodeProtobufToJson(anyMessage.value as Uint8Array)
                            };
                        }
                    } catch {
                        result.result = anyMessage;
                    }
                } else {
                    result.result = anyMessage;
                }
            } else if (chunk.payload.case === "error") {
                const codeNum = (chunk.payload.value as any).code as number;
                result.error = {
                    code: (ToolError_Code[codeNum] as string) ?? "UNKNOWN",
                    message: (chunk.payload.value as any).message,
                    details: (chunk.payload.value as any).details
                };
            }

            results.push(result);

            if (chunk.final) {
                break;
            }
        }

        return {
            success: true,
            results: results
        };
    }

    private tryDecodeProtobufToJson(bytes: Uint8Array): any {
        try {
            // Simple heuristic to extract readable fields from protobuf bytes
            // This is a temporary solution - proper implementation would use reflection
            const result: any = {};
            let pos = 0;

            while (pos < bytes.length) {
                // Read protobuf varint tag
                let tag = 0;
                let shift = 0;
                while (pos < bytes.length) {
                    const byte = bytes[pos++];
                    tag |= (byte & 0x7F) << shift;
                    if ((byte & 0x80) === 0) break;
                    shift += 7;
                }

                const fieldNumber = tag >>> 3;
                const wireType = tag & 0x7;

                // Handle different wire types
                if (wireType === 1) { // 64-bit fixed
                    if (pos + 8 <= bytes.length) {
                        const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 8);
                        result[`field_${fieldNumber}`] = view.getFloat64(0, true);
                        pos += 8;
                    } else break;
                } else if (wireType === 2) { // Length-delimited (string/bytes)
                    let length = 0;
                    let lengthShift = 0;
                    while (pos < bytes.length) {
                        const byte = bytes[pos++];
                        length |= (byte & 0x7F) << lengthShift;
                        if ((byte & 0x80) === 0) break;
                        lengthShift += 7;
                    }
                    if (pos + length <= bytes.length) {
                        const stringBytes = bytes.slice(pos, pos + length);
                        try {
                            result[`field_${fieldNumber}`] = new TextDecoder().decode(stringBytes);
                        } catch {
                            result[`field_${fieldNumber}`] = Array.from(stringBytes);
                        }
                        pos += length;
                    } else break;
                } else if (wireType === 0) { // Varint
                    let value = 0;
                    let valueShift = 0;
                    while (pos < bytes.length) {
                        const byte = bytes[pos++];
                        value |= (byte & 0x7F) << valueShift;
                        if ((byte & 0x80) === 0) break;
                        valueShift += 7;
                    }
                    result[`field_${fieldNumber}`] = value;
                } else {
                    // Skip unknown wire types
                    break;
                }
            }

            return result;
        } catch {
            return Array.from(bytes);
        }
    }

    async discover(): Promise<Array<{ name: string; title: string; description: string; inputType: string; outputType: string; annotations: Record<string, string> }>> {
        const res = await this.listTools();
        return res.tools;
    }

    async *call(name: string, args: any): AsyncIterable<any> {
        const { results } = await this.callTool(name, args);
        for (const r of results) {
            yield r;
        }
    }

    getReflectionInfo(): any | null {
        return {
            meta: {
                serverId: "",
                serverVersion: "",
                services: ["mcp.v0.McpService"],
                methods: { "mcp.v0.McpService": ["ListTools", "CallTool"] }
            }
        };
    }

    close(): void {}

    validateInputs(toolSchema: any, inputs: any): string[] {
        const errors: string[] = [];
        const properties = toolSchema.inputSchema?.properties || {};
        const required = toolSchema.inputSchema?.required || [];
        for (const field of required) {
            if (!inputs.hasOwnProperty(field) || inputs[field] === '' || inputs[field] == null) {
                errors.push(`Field '${field}' is required`);
            }
        }
        for (const [field, value] of Object.entries(inputs)) {
            if (!properties[field]) continue;
            const expectedType = properties[field].type;
            const actualType = typeof value;
            if (expectedType === 'string' && actualType !== 'string') {
                errors.push(`Field '${field}' must be a string, got ${actualType}`);
            } else if (expectedType === 'number' && (actualType !== 'number' || isNaN(value as number))) {
                errors.push(`Field '${field}' must be a number, got ${actualType}`);
            } else if (expectedType === 'integer' && (actualType !== 'number' || !Number.isInteger(value as number))) {
                errors.push(`Field '${field}' must be an integer, got ${actualType === 'number' ? 'decimal' : actualType}`);
            }
            if (properties[field].enum && !properties[field].enum.includes(value)) {
                errors.push(`Field '${field}' must be one of: ${properties[field].enum.join(', ')}`);
            }
        }
        return errors;
    }
}