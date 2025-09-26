import OpenAI from 'openai';
import { RealMcpClient } from './real_client';

interface ToolMetadata {
    name: string;
    title: string;
    description: string;
    inputType: string;
    outputType: string;
    grpcService: string;
    grpcMethod: string;
    annotations: Record<string, string>;
}

interface ChatMessage {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    name?: string;
    tool_calls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
    tool_call_id?: string;
}

interface LLMConfig {
    apiKey: string;
    systemPrompt?: string;
    onLog?: (message: string, type?: 'info' | 'success' | 'error') => void;
}

export class LLMIntegration {
    private openai: OpenAI | null = null;
    private model: string = 'gpt-4.1-mini';
    private systemPrompt: string = '';
    private conversation: ChatMessage[] = [];
    private onLog?: (message: string, type?: 'info' | 'success' | 'error') => void;

    constructor(
        private mcpClient: RealMcpClient,
        config?: LLMConfig
    ) {
        if (config?.apiKey) {
            this.openai = new OpenAI({
                apiKey: config.apiKey,
                dangerouslyAllowBrowser: true
            });
        }

        this.systemPrompt = config?.systemPrompt || this.getDefaultSystemPrompt();
        this.onLog = config?.onLog;
    }

    updateConfig(config: LLMConfig): void {
        if (config.apiKey) {
            this.openai = new OpenAI({
                apiKey: config.apiKey,
                dangerouslyAllowBrowser: true
            });
        }

        if (config.systemPrompt !== undefined) {
            this.systemPrompt = config.systemPrompt;
        }

        if (config.onLog) {
            this.onLog = config.onLog;
        }
    }

    private getDefaultSystemPrompt(): string {
        return `You are a helpful assistant that can use various tools to help users.

Available tools will be automatically discovered from the MCP server.

When you need to use a tool, call the appropriate function with the correct parameters.`;
    }

    async updateSystemPromptWithTools(): Promise<void> {
        try {
            const tools = await this.mcpClient.discover();
            this.systemPrompt = `You are a helpful assistant that can use various tools to help users.

Available tools:
${tools.map(tool => `- ${tool.name}: ${tool.description}`).join('\n')}

When you need to use a tool, call the appropriate function with the correct parameters.`;
        } catch (error) {
            console.error('Failed to update system prompt with tools:', error);
        }
    }

    private async getToolsForOpenAI(): Promise<OpenAI.Chat.Completions.ChatCompletionTool[]> {
        try {
            const tools = await this.mcpClient.discover();
            return tools.map(tool => ({
                type: 'function' as const,
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: this.generateSchemaFromType(tool.inputType) // We'll need to implement this
                }
            }));
        } catch (error) {
            console.error('Failed to get tools for OpenAI:', error);
            return [];
        }
    }

    // Generate a basic JSON schema for the tool input type
    private generateSchemaFromType(inputType: string): any {
        // For now, return a generic schema - this could be enhanced to introspect the actual proto types
        if (inputType === 'examples.weather.GetWeatherRequest') {
            return {
                type: 'object',
                properties: {
                    location: { type: 'string', description: 'City or place' },
                    units: { type: 'string', enum: ['metric', 'imperial'], description: 'Unit system' }
                },
                required: ['location']
            };
        }

        if (inputType === 'examples.weather.GetWeatherForecastRequest') {
            return {
                type: 'object',
                properties: {
                    location: { type: 'string', description: 'City or place' },
                    date: { type: 'string', description: 'Date for forecast' },
                    units: { type: 'string', enum: ['metric', 'imperial'], description: 'Unit system' }
                },
                required: ['location', 'date']
            };
        }

        // Default generic schema
        return {
            type: 'object',
            properties: {},
            required: []
        };
    }

    async sendMessage(userMessage: string): Promise<ChatMessage[]> {
        if (!this.openai) {
            throw new Error('OpenAI client not configured. Please provide an API key.');
        }

        // Add user message to conversation
        this.conversation.push({ role: 'user', content: userMessage });

        try {
            await this.processConversation();
            return [...this.conversation];
        } catch (error: any) {
            console.error('LLM Error:', error);
            const errorMessage: ChatMessage = {
                role: 'assistant',
                content: `Error: ${error.message}`
            };
            this.conversation.push(errorMessage);
            return [...this.conversation];
        }
    }

    private async processConversation(): Promise<void> {
        const tools = await this.getToolsForOpenAI();

        // Build messages array for OpenAI
        const messages = this.buildOpenAIMessages();

        const response = await this.openai!.chat.completions.create({
            model: this.model,
            messages,
            tools: tools.length > 0 ? tools : undefined,
            tool_choice: tools.length > 0 ? 'auto' : undefined
        });

        const assistantMessage = response.choices[0]?.message;
        if (!assistantMessage) {
            throw new Error('No response from OpenAI');
        }

        // Handle the response
        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
            // Add assistant message with tool calls
            this.conversation.push({
                role: 'assistant',
                content: assistantMessage.content || '',
                tool_calls: assistantMessage.tool_calls
            });

            // Execute all tool calls
            for (const toolCall of assistantMessage.tool_calls) {
                if (toolCall.type === 'function') {
                    try {
                        const toolName = toolCall.function.name;
                        const toolArgs = JSON.parse(toolCall.function.arguments);

                        console.log(`Calling tool: ${toolName} with args:`, toolArgs);
                        this.onLog?.(`🛠️ Calling tool: ${toolName}`, 'info');

                        // Validate inputs first using the same validation as the UI (client-side)
                        const validationErrors = await this.mcpClient.validateInputs(toolName, toolArgs);
                        if (validationErrors.length > 0) {
                            // If client-side validation fails, return the first error
                            this.conversation.push({
                                role: 'tool',
                                content: `Client-side Validation Error: ${validationErrors[0]}`,
                                name: toolName,
                                tool_call_id: toolCall.id
                            });
                            console.log(`Tool ${toolName} client-side validation failed:`, validationErrors);
                            this.onLog?.(`❌ Tool ${toolName} client-side validation failed: ${validationErrors[0]}`, 'error');
                            continue;
                        }

                        // Client-side validation passed, now call the tool
                        const toolResult = await this.mcpClient.callTool(toolName, toolArgs);

                        // Check if the server returned a validation error
                        if (!toolResult.success && toolResult.results?.[0]?.error) {
                            const serverError = toolResult.results[0].error;

                            // Check if this looks like a server-side validation error
                            const errorMessage = typeof serverError === 'string' ? serverError :
                                               serverError.message || JSON.stringify(serverError);

                            this.conversation.push({
                                role: 'tool',
                                content: `Server-side Validation Error: ${errorMessage}`,
                                name: toolName,
                                tool_call_id: toolCall.id
                            });
                            console.log(`Tool ${toolName} server-side validation failed:`, serverError);
                            this.onLog?.(`❌ Tool ${toolName} server-side validation failed: ${errorMessage}`, 'error');
                        } else {
                            // Successful result
                            this.conversation.push({
                                role: 'tool',
                                content: JSON.stringify(toolResult.results, null, 2),
                                name: toolName,
                                tool_call_id: toolCall.id
                            });

                            console.log(`Tool ${toolName} result:`, toolResult);
                            this.onLog?.(`✅ Tool ${toolName} completed successfully`, 'success');
                        }

                    } catch (error: any) {
                        console.error(`Tool call failed: ${toolCall.function.name}`, error);
                        this.onLog?.(`❌ Tool ${toolCall.function.name} failed: ${error.message}`, 'error');
                        this.conversation.push({
                            role: 'tool',
                            content: `Error: ${error.message}`,
                            name: toolCall.function.name,
                            tool_call_id: toolCall.id
                        });
                    }
                }
            }

            // Get follow-up response after all tools are executed
            await this.getFollowUpResponse();
        } else {
            // No tool calls, just add the assistant message
            this.conversation.push({
                role: 'assistant',
                content: assistantMessage.content || ''
            });
        }
    }

    private buildOpenAIMessages(): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: 'system', content: this.systemPrompt }
        ];

        for (const msg of this.conversation) {
            if (msg.role === 'user') {
                messages.push({
                    role: 'user',
                    content: msg.content
                });
            } else if (msg.role === 'assistant') {
                const assistantMsg: any = {
                    role: 'assistant',
                    content: msg.content
                };

                if (msg.tool_calls) {
                    assistantMsg.tool_calls = msg.tool_calls;
                }

                messages.push(assistantMsg);
            } else if (msg.role === 'tool') {
                messages.push({
                    role: 'tool',
                    content: msg.content,
                    tool_call_id: msg.tool_call_id!
                });
            }
        }

        return messages;
    }

    private async getFollowUpResponse(): Promise<void> {
        try {
            const tools = await this.getToolsForOpenAI();
            const messages = this.buildOpenAIMessages();

            const followUpResponse = await this.openai!.chat.completions.create({
                model: this.model,
                messages,
                tools: tools.length > 0 ? tools : undefined,
                tool_choice: tools.length > 0 ? 'auto' : undefined
            });

            const followUpMessage = followUpResponse.choices[0]?.message;
            if (followUpMessage?.content) {
                this.conversation.push({
                    role: 'assistant',
                    content: followUpMessage.content
                });
            }
        } catch (error: any) {
            console.error('Follow-up response error:', error);
            this.conversation.push({
                role: 'assistant',
                content: `Error getting follow-up response: ${error.message}`
            });
        }
    }


    getConversation(): ChatMessage[] {
        return [...this.conversation];
    }

    clearConversation(): void {
        this.conversation = [];
    }

    async getAvailableTools(): Promise<ToolMetadata[]> {
        return await this.mcpClient.discover();
    }
}