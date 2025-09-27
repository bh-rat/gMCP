import React, { useState, useCallback } from 'react'
import LLMIntegration from './LLMIntegration'

interface Tool {
  name: string
  description: string
  inputSchema: {
    type: string
    properties: Record<string, any>
    required: string[]
  }
}

const App: React.FC = () => {
  const [connected, setConnected] = useState(false)
  const [clientId, setClientId] = useState<string | null>(null)
  const [tools, setTools] = useState<Tool[]>([])
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null)
  const [reflectionInfo, setReflectionInfo] = useState<any>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [status, setStatus] = useState<{ message: string; type: 'info' | 'success' | 'error' }>({ message: '', type: 'info' })
  const [result, setResult] = useState<string>('')

  const [serverAddress, setServerAddress] = useState('localhost:8000')
  const [useAuth, setUseAuth] = useState('none')
  const [jwtToken, setJwtToken] = useState('')
  const [jsonOverride, setJsonOverride] = useState('')
  const [formInputs, setFormInputs] = useState<Record<string, string>>({})

  const log = useCallback((message: string, type: 'info' | 'success' | 'error' = 'info') => {
    console.log(`[${type.toUpperCase()}] ${message}`)
    const timestamp = new Date().toLocaleTimeString()
    setLogs(prev => [...prev, `[${timestamp}] ${message}`])
    setStatus({ message, type })
  }, [])

  const makeApiCall = useCallback(async (endpoint: string, data?: any) => {
    const options: RequestInit = {
      method: data ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' }
    }

    if (data) {
      options.body = JSON.stringify(data)
    }

    const response = await fetch(`/api/${endpoint}`, options)
    const result = await response.json()

    if (!response.ok) {
      throw new Error(result.error || `HTTP ${response.status}`)
    }

    return result
  }, [])

  const handleConnect = useCallback(async () => {
    log(`🔌 Connecting to ${serverAddress}...`)

    try {
      const result = await makeApiCall('connect', { address: serverAddress, useAuth, jwtToken })

      if (result.success) {
        setConnected(true)
        setClientId(result.clientId)
        setReflectionInfo(result.reflectionInfo)
        log('✅ Connected successfully!', 'success')
      }
    } catch (error: any) {
      log(`❌ Connection failed: ${error.message}`, 'error')
    }
  }, [serverAddress, useAuth, jwtToken, makeApiCall, log])

  const handleDisconnect = useCallback(async () => {
    if (clientId) {
      try {
        await makeApiCall('disconnect', { clientId })
      } catch (error) {
        console.error('Disconnect error:', error)
      }
    }

    setConnected(false)
    setClientId(null)
    setTools([])
    setSelectedTool(null)
    setReflectionInfo(null)
    setResult('')
    log('🔌 Disconnected')
  }, [clientId, makeApiCall, log])

  const handleListTools = useCallback(async () => {
    if (!connected || !clientId) {
      log('❌ Not connected to server', 'error')
      return
    }

    log('📋 Listing tools...')

    try {
      const result = await makeApiCall('list-tools', { clientId })

      if (result.success) {
        setTools(result.tools)
        log(`✅ Found ${result.tools.length} tools`, 'success')
      }
    } catch (error: any) {
      log(`❌ ListTools failed: ${error.message}`, 'error')
    }
  }, [connected, clientId, makeApiCall, log])

  const handleSelectTool = useCallback((tool: Tool) => {
    setSelectedTool(tool)
    setFormInputs({})
    log(`🎯 Selected: ${tool.name}`)
  }, [log])

  const collectInputs = useCallback((): Record<string, any> => {
    log(`🔍 JSON override: "${jsonOverride}"`)

    if (jsonOverride.trim()) {
      try {
        const params = JSON.parse(jsonOverride)
        log(`📝 Using JSON override: ${JSON.stringify(params)}`)
        return params
      } catch (error: any) {
        throw new Error(`Invalid JSON: ${error.message}`)
      }
    }

    const params: Record<string, any> = {}
    const properties = selectedTool?.inputSchema?.properties

    if (!properties) return {}

    Object.keys(properties).forEach(name => {
      const value = formInputs[name]?.trim()
      if (value) {
        const schema = properties[name]
        if (schema.type === 'number' || schema.type === 'integer') {
          const numValue = Number(value)
          params[name] = isNaN(numValue) ? value : numValue
        } else {
          params[name] = value
        }
      }
    })

    log(`🔍 Form inputs: ${JSON.stringify(params)}`)
    return params
  }, [jsonOverride, formInputs, selectedTool, log])

  const handleCallTool = useCallback(async () => {
    log('🔴 Call Tool clicked')

    if (!selectedTool) {
      log('❌ No tool selected', 'error')
      return
    }

    if (!connected || !clientId) {
      log('❌ Not connected to server', 'error')
      return
    }

    try {
      const args = collectInputs()
      log(`🔍 Args collected: ${JSON.stringify(args)}`)

      const requestData = {
        clientId,
        toolName: selectedTool.name,
        args,
        useAuth,
        jwtToken
      }

      log(`📤 Request: ${JSON.stringify(requestData)}`)

      const result = await makeApiCall('call-tool', requestData)

      log(`📥 Response: ${JSON.stringify(result)}`)

      if (result.success) {
        setResult(`SUCCESS:\n${JSON.stringify(result.results, null, 2)}`)
        log('✅ Tool call successful', 'success')
      } else {
        setResult(`ERROR:\n${JSON.stringify(result, null, 2)}`)
        // Use validation_type to provide specific error messages
        if (result.validation_type === 'client-side') {
          log(`❌ Tool call client-side validation failed: ${result.error}`, 'error')
        } else if (result.validation_type === 'server-side') {
          log(`❌ Tool call server-side error: ${result.error}`, 'error')
        } else {
          // Fallback for backwards compatibility
          log(`❌ Tool call failed: ${result.error}`, 'error')
        }
      }

    } catch (error: any) {
      log(`❌ Tool call error: ${error.message}`, 'error')
      setResult(`ERROR:\n${error.message}`)
    }
  }, [selectedTool, connected, clientId, collectInputs, useAuth, jwtToken, makeApiCall, log])

  const handleFormInputChange = useCallback((name: string, value: string) => {
    setFormInputs(prev => ({ ...prev, [name]: value }))
  }, [])


  const clearLogs = useCallback(() => {
    setLogs([])
  }, [])

  return (
    <div style={{ fontFamily: 'Segoe UI, sans-serif', maxWidth: '1200px', margin: '0 auto', padding: '20px', background: '#f5f5f5' }}>
      <div style={{ background: 'white', borderRadius: '8px', padding: '30px', boxShadow: '0 2px 10px rgba(0,0,0,0.1)' }}>
        <h1 style={{ color: '#333', textAlign: 'center', marginBottom: '30px' }}>🎯 MCP gRPC Client</h1>

        {/* Connection Section */}
        <div style={{ marginBottom: '30px', padding: '20px', border: '1px solid #0066cc', borderRadius: '6px', background: '#f0f8ff' }}>
          <h2 style={{ marginTop: 0, color: '#555', fontSize: '18px' }}>🔌 Server Connection</h2>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px', color: '#444' }}>Server Address:</label>
            <input
              type="text"
              value={serverAddress}
              onChange={(e) => setServerAddress(e.target.value)}
              placeholder="localhost:8000"
              style={{ width: '100%', padding: '8px 12px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px', boxSizing: 'border-box' }}
            />
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px', color: '#444' }}>Authentication:</label>
            <select
              value={useAuth}
              onChange={(e) => setUseAuth(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px', boxSizing: 'border-box' }}
            >
              <option value="none">No Authentication</option>
              <option value="jwt">JWT Token (Kong Gateway)</option>
            </select>
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px', color: '#444' }}>JWT Token:</label>
            <input
              type="text"
              value={jwtToken}
              onChange={(e) => setJwtToken(e.target.value)}
              placeholder="Bearer token for Kong gateway"
              style={{ width: '100%', padding: '8px 12px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px', boxSizing: 'border-box' }}
            />
          </div>

          <button
            onClick={handleConnect}
            disabled={connected}
            style={{ background: connected ? '#6c757d' : '#28a745', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '4px', cursor: connected ? 'not-allowed' : 'pointer', fontSize: '14px', fontWeight: 'bold', marginRight: '10px' }}
          >
            🚀 Connect & Load Reflection
          </button>

          <button
            onClick={handleDisconnect}
            disabled={!connected}
            style={{ background: !connected ? '#6c757d' : '#dc3545', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '4px', cursor: !connected ? 'not-allowed' : 'pointer', fontSize: '14px', fontWeight: 'bold' }}
          >
            🔌 Disconnect
          </button>

          {status.message && (
            <div style={{
              padding: '10px',
              borderRadius: '4px',
              margin: '10px 0',
              fontWeight: 'bold',
              background: status.type === 'success' ? '#d4edda' : status.type === 'error' ? '#f8d7da' : '#d1ecf1',
              color: status.type === 'success' ? '#155724' : status.type === 'error' ? '#721c24' : '#0c5460',
              border: `1px solid ${status.type === 'success' ? '#c3e6cb' : status.type === 'error' ? '#f5c6cb' : '#bee5eb'}`
            }}>
              {status.message}
            </div>
          )}

          {reflectionInfo && (
            <div style={{ background: '#e8f4fd', border: '1px solid #bee5eb', borderRadius: '4px', padding: '15px', marginTop: '10px', fontFamily: 'Courier New, monospace', fontSize: '12px' }}>
              <h4>📡 Reflection Information:</h4>
              <div>
                <strong>Server ID:</strong> {reflectionInfo.meta.serverId}<br />
                <strong>Version:</strong> {reflectionInfo.meta.serverVersion}<br />
                <strong>Services:</strong> {reflectionInfo.meta.services.join(', ')}<br />
                <strong>Available Methods:</strong><br />
                {Object.entries(reflectionInfo.meta.methods).map(([service, methods]: [string, any]) =>
                  <div key={service}>  • {service}: {methods.join(', ')}</div>
                )}
                <br />
                <em>🎯 Real gRPC reflection data!</em>
              </div>
            </div>
          )}
        </div>

        {/* Tools Section */}
        <div style={{ marginBottom: '30px', padding: '20px', border: '1px solid #008000', borderRadius: '6px', background: '#f0fff0' }}>
          <h2 style={{ marginTop: 0, color: '#555', fontSize: '18px' }}>🛠️ Available Tools</h2>

          <button
            onClick={handleListTools}
            disabled={!connected}
            style={{ background: !connected ? '#6c757d' : '#007bff', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '4px', cursor: !connected ? 'not-allowed' : 'pointer', fontSize: '14px', fontWeight: 'bold' }}
          >
            📋 List Tools
          </button>

          {tools.length > 0 && (
            <div style={{ background: 'white', border: '1px solid #ddd', borderRadius: '4px', maxHeight: '150px', overflowY: 'auto', marginTop: '10px' }}>
              {tools.map((tool, index) => (
                <div
                  key={index}
                  onClick={() => handleSelectTool(tool)}
                  style={{
                    padding: '10px',
                    borderBottom: '1px solid #eee',
                    cursor: 'pointer',
                    background: selectedTool?.name === tool.name ? '#e3f2fd' : 'white',
                    borderLeft: selectedTool?.name === tool.name ? '4px solid #2196f3' : 'none'
                  }}
                  onMouseEnter={(e) => {
                    if (selectedTool?.name !== tool.name) {
                      e.currentTarget.style.background = '#f0f0f0'
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (selectedTool?.name !== tool.name) {
                      e.currentTarget.style.background = 'white'
                    }
                  }}
                >
                  <strong>{tool.name}</strong><br />
                  <small>{tool.description}</small>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Tool Call Section */}
        <div style={{ marginBottom: '30px', padding: '20px', border: '1px solid #ffa500', borderRadius: '6px', background: '#fff8dc' }}>
          <h2 style={{ marginTop: 0, color: '#555', fontSize: '18px' }}>🎯 Call Tool</h2>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px', color: '#444' }}>Selected Tool:</label>
            <div>{selectedTool ? selectedTool.name : 'No tool selected'}</div>
          </div>

          <div style={{ background: '#f0f8ff', padding: '15px', borderRadius: '4px', margin: '10px 0', borderLeft: '4px solid #0066cc' }}>
            <h4>🧪 Testing Validation:</h4>
            <p><strong>Use JSON Override to test server-side validation:</strong></p>
            <ul style={{ margin: '10px 0', paddingLeft: '20px' }}>
              <li><strong>Required field:</strong> {`{"location": "", "units": "metric"}`} → "string.min_len violation"</li>
              <li><strong>Enum validation:</strong> {`{"location": "NYC", "units": "fahrenheit"}`} → "string.in violation"</li>
              <li><strong>CEL validation:</strong> {`{"location": "NYC", "units": "imperial"}`} → "imperial requires US location"</li>
              <li><strong>Valid data:</strong> {`{"location": "NYC, US", "units": "imperial"}`} → Successful call</li>
            </ul>
            <p><em>🔄 All validation happens on gRPC server with protovalidate</em></p>
          </div>

          {selectedTool && (
            <div style={{ background: '#f9f9f9', border: '1px solid #ddd', borderRadius: '4px', padding: '15px', marginTop: '10px' }}>
              <h4>Parameters:</h4>

              {selectedTool.inputSchema?.properties && (
                <div>
                  {Object.entries(selectedTool.inputSchema.properties).map(([name, schema]: [string, any]) => (
                    <div key={name} style={{ marginBottom: '10px' }}>
                      <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px', color: '#444' }}>
                        {name}{selectedTool.inputSchema.required?.includes(name) ? ' *' : ''}: {schema.description || ''}
                      </label>
                      {schema.enum ? (
                        <select
                          value={formInputs[name] || ''}
                          onChange={(e) => handleFormInputChange(name, e.target.value)}
                          style={{ width: '100%', padding: '8px 12px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px', boxSizing: 'border-box' }}
                        >
                          <option value="">Select {name}</option>
                          {schema.enum.map((option: string) => (
                            <option key={option} value={option}>{option}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={schema.type === 'number' || schema.type === 'integer' ? 'number' : 'text'}
                          step={schema.type === 'integer' ? '1' : 'any'}
                          value={formInputs[name] || ''}
                          onChange={(e) => handleFormInputChange(name, e.target.value)}
                          placeholder={schema.description || `Enter ${name}`}
                          style={{ width: '100%', padding: '8px 12px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px', boxSizing: 'border-box' }}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div style={{ marginTop: '20px' }}>
                <div style={{ background: '#fff3cd', padding: '10px', borderRadius: '4px', marginBottom: '10px', borderLeft: '4px solid #ffc107' }}>
                  <strong>🧪 JSON Override:</strong> Enter raw JSON to test validation scenarios (takes precedence over form inputs)
                </div>
                <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px', color: '#444' }}>JSON Override (optional):</label>
                <textarea
                  rows={4}
                  value={jsonOverride}
                  onChange={(e) => setJsonOverride(e.target.value)}
                  placeholder='{"location": "New York", "units": "metric"}'
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px', boxSizing: 'border-box' }}
                />
              </div>

              <button
                onClick={handleCallTool}
                style={{ background: '#007bff', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '4px', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold', marginTop: '10px' }}
              >
                🚀 Call Tool
              </button>
            </div>
          )}

          {result && (
            <div style={{ background: '#f8f9fa', border: '1px solid #dee2e6', borderRadius: '4px', padding: '15px', marginTop: '10px', minHeight: '100px', whiteSpace: 'pre-wrap', fontFamily: 'Courier New, monospace', fontSize: '12px' }}>
              {result}
            </div>
          )}
        </div>

        {/* LLM Integration Section */}
        <LLMIntegration
          tools={tools}
          connected={connected}
          clientId={clientId}
          makeApiCall={makeApiCall}
          log={log}
        />

        {/* Log Section */}
        <div style={{ padding: '20px', border: '1px solid #e0e0e0', borderRadius: '6px', background: '#fafafa' }}>
          <h2 style={{ marginTop: 0, color: '#555', fontSize: '18px' }}>📝 Activity Log</h2>

          <button
            onClick={clearLogs}
            style={{ background: '#007bff', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '4px', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold', marginBottom: '10px' }}
          >
            🗑️ Clear Log
          </button>

          <div style={{ background: '#f8f9fa', border: '1px solid #e9ecef', borderRadius: '4px', padding: '15px', height: '200px', overflowY: 'auto', fontFamily: 'Courier New, monospace', fontSize: '12px', whiteSpace: 'pre-wrap' }}>
            {logs.join('\n')}
          </div>
        </div>
      </div>
    </div>
  )
}

export default App