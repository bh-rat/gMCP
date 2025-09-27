import React, { useState, useCallback, useEffect } from 'react'

interface Tool {
  name: string
  description: string
  inputSchema: {
    type: string
    properties: Record<string, any>
    required: string[]
  }
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  name?: string
}

interface LLMIntegrationProps {
  tools: Tool[]
  connected: boolean
  clientId: string | null
  makeApiCall: (endpoint: string, data?: any) => Promise<any>
  log: (message: string, type?: 'info' | 'success' | 'error') => void
}

const LLMIntegration: React.FC<LLMIntegrationProps> = ({ tools, connected, clientId, makeApiCall, log }) => {
  const [apiKey, setApiKey] = useState('')
  const [userPrompt, setUserPrompt] = useState('')
  const [systemPrompt, setSystemPrompt] = useState(`You are a helpful assistant that can use various tools to help users.

Available tools:
${tools.map(tool => `- ${tool.name}: ${tool.description}`).join('\n')}

When you need to use a tool, call the appropriate function with the correct parameters.`)
  const [conversation, setConversation] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)

  // Initialize LLM integration when config changes
  const initializeLLM = useCallback(async () => {
    if (!apiKey || !connected || !clientId) {
      setIsInitialized(false)
      return
    }

    log('🤖 Initializing LLM integration...', 'info')

    try {
      await makeApiCall('llm-init', {
        clientId,
        apiKey,
        systemPrompt
      })
      setIsInitialized(true)
      log('✅ LLM integration initialized successfully', 'success')
    } catch (error: any) {
      console.error('Failed to initialize LLM:', error)
      setIsInitialized(false)
      log(`❌ LLM initialization failed: ${error.message}`, 'error')
    }
  }, [apiKey, connected, clientId, systemPrompt, makeApiCall, log])

  // Auto-initialize when config is ready
  useEffect(() => {
    if (apiKey && connected && clientId) {
      initializeLLM()
    }
  }, [apiKey, connected, clientId, initializeLLM])

  const handleSendMessage = useCallback(async () => {
    if (!userPrompt.trim() || !isInitialized || !clientId) return

    const messageToSend = userPrompt
    setIsLoading(true)
    setUserPrompt('')

    log(`🤖 Sending message to LLM: "${messageToSend}"`, 'info')

    try {
      const result = await makeApiCall('llm-send', {
        clientId,
        message: messageToSend
      })

      if (result.success) {
        setConversation(result.conversation)

        // Add any logs from the server to the activity log
        if (result.logs && result.logs.length > 0) {
          result.logs.forEach((logEntry: any) => {
            log(logEntry.message, logEntry.type)
          })
        }

        log('✅ LLM conversation updated successfully', 'success')
      } else {
        throw new Error(result.error)
      }
    } catch (error: any) {
      console.error('LLM Error:', error)
      log(`❌ LLM conversation failed: ${error.message}`, 'error')
      setConversation(prev => [...prev, {
        role: 'assistant',
        content: `Error: ${error.message}`
      }])
    } finally {
      setIsLoading(false)
    }
  }, [userPrompt, isInitialized, clientId, makeApiCall, log])

  const clearConversation = useCallback(async () => {
    if (!isInitialized || !clientId) return

    log('🗑️ Clearing LLM conversation...', 'info')

    try {
      await makeApiCall('llm-clear', { clientId })
      setConversation([])
      log('✅ LLM conversation cleared successfully', 'success')
    } catch (error: any) {
      console.error('Failed to clear conversation:', error)
      log(`❌ Failed to clear LLM conversation: ${error.message}`, 'error')
    }
  }, [isInitialized, clientId, makeApiCall, log])

  return (
    <div style={{
      marginBottom: '30px',
      padding: '20px',
      border: '1px solid #9b59b6',
      borderRadius: '6px',
      background: '#faf5ff'
    }}>
      <h2 style={{ marginTop: 0, color: '#555', fontSize: '18px' }}>🤖 LLM Integration</h2>

      {/* Configuration Section */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px', color: '#444' }}>
            OpenAI API Key:
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            style={{
              width: '100%',
              padding: '8px 12px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              fontSize: '14px',
              boxSizing: 'border-box'
            }}
          />
        </div>

        <div style={{ marginBottom: '15px', padding: '10px', background: '#e8f5e8', border: '1px solid #4caf50', borderRadius: '4px' }}>
          <div style={{ fontWeight: 'bold', color: '#2e7d2e', marginBottom: '5px' }}>
            🤖 Model: GPT-4.1 Mini
          </div>
          <div style={{ fontSize: '12px', color: '#666' }}>
            Fixed to use GPT-4.1 Mini for optimal performance and cost efficiency
          </div>
        </div>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px', color: '#444' }}>
            System Prompt:
          </label>
          <textarea
            rows={4}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              fontSize: '14px',
              boxSizing: 'border-box',
              resize: 'vertical'
            }}
          />
        </div>
      </div>

      {/* Conversation Display */}
      <div style={{
        background: '#white',
        border: '1px solid #ddd',
        borderRadius: '4px',
        height: '300px',
        overflowY: 'auto',
        padding: '15px',
        marginBottom: '15px',
        fontFamily: 'system-ui, -apple-system, sans-serif'
      }}>
        {conversation.length === 0 ? (
          <div style={{ color: '#666', fontStyle: 'italic' }}>
            Start a conversation by typing a message below...
          </div>
        ) : (
          conversation.map((message, index) => (
            <div key={index} style={{
              marginBottom: '15px',
              padding: '10px',
              borderRadius: '6px',
              background: message.role === 'user' ? '#e3f2fd' :
                          message.role === 'assistant' ? '#f1f8e9' : '#fff3e0'
            }}>
              <div style={{
                fontWeight: 'bold',
                marginBottom: '5px',
                color: message.role === 'user' ? '#1976d2' :
                       message.role === 'assistant' ? '#388e3c' : '#f57c00'
              }}>
                {message.role === 'user' ? '👤 You' :
                 message.role === 'assistant' ? '🤖 Assistant' :
                 `🛠️ Tool: ${message.name}`}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: '14px' }}>
                {message.content}
              </div>
            </div>
          ))
        )}
        {isLoading && (
          <div style={{
            color: '#666',
            fontStyle: 'italic',
            padding: '10px',
            textAlign: 'center'
          }}>
            🤔 Thinking...
          </div>
        )}
      </div>

      {/* Input Section */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
        <input
          type="text"
          value={userPrompt}
          onChange={(e) => setUserPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !isLoading && handleSendMessage()}
          placeholder="Type your message..."
          disabled={!apiKey || !connected || isLoading}
          style={{
            flex: 1,
            padding: '10px 12px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            fontSize: '14px'
          }}
        />
        <button
          onClick={handleSendMessage}
          disabled={!isInitialized || !userPrompt.trim() || isLoading}
          style={{
            background: (!isInitialized || !userPrompt.trim() || isLoading) ? '#6c757d' : '#007bff',
            color: 'white',
            border: 'none',
            padding: '10px 20px',
            borderRadius: '4px',
            cursor: (!isInitialized || !userPrompt.trim() || isLoading) ? 'not-allowed' : 'pointer',
            fontSize: '14px',
            fontWeight: 'bold'
          }}
        >
          {isLoading ? '⏳' : '📤'} Send
        </button>
        <button
          onClick={clearConversation}
          style={{
            background: '#dc3545',
            color: 'white',
            border: 'none',
            padding: '10px 20px',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 'bold'
          }}
        >
          🗑️ Clear
        </button>
      </div>

      {/* Status */}
      <div style={{ fontSize: '12px', color: '#666' }}>
        Status: {!apiKey ? '⚠️ API Key required' :
                !connected ? '⚠️ Not connected to server' :
                !isInitialized ? '⏳ Initializing...' :
                `✅ Ready (${tools.length} tools available)`}
      </div>
    </div>
  )
}

export default LLMIntegration