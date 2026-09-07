using Azure.Core;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using ModelContextProtocol.Client;

namespace AgentWorkflow.Core.Mcp;

/// <summary>
/// Connects to the configured MCP servers once, lists their tools, and exposes them as
/// <see cref="AITool"/> instances that Agent Framework agents call through function calling.
/// Register as a singleton; the MCP sessions are long-lived.
/// </summary>
public sealed class McpToolSource : IAsyncDisposable
{
    private readonly McpOptions _options;
    private readonly TokenCredential _credential;
    private readonly ILoggerFactory _loggerFactory;
    private readonly ILogger<McpToolSource> _logger;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly List<McpClient> _clients = [];
    private IReadOnlyList<AITool>? _tools;

    public McpToolSource(IOptions<McpOptions> options, TokenCredential credential, ILoggerFactory? loggerFactory = null)
    {
        _options = options.Value;
        _credential = credential;
        _loggerFactory = loggerFactory ?? NullLoggerFactory.Instance;
        _logger = _loggerFactory.CreateLogger<McpToolSource>();
    }

    /// <summary>Returns every allowed tool across all configured servers (cached after first call).</summary>
    public async Task<IReadOnlyList<AITool>> GetToolsAsync(CancellationToken cancellationToken = default)
    {
        if (_tools is not null)
        {
            return _tools;
        }

        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_tools is not null)
            {
                return _tools;
            }

            var tools = new List<AITool>();
            foreach (McpServerOptions server in _options.Servers)
            {
                McpClient client = await ConnectAsync(server, cancellationToken).ConfigureAwait(false);
                _clients.Add(client);

                IList<McpClientTool> serverTools = await client.ListToolsAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
                foreach (McpClientTool tool in serverTools)
                {
                    if (server.AllowedTools.Count > 0 && !server.AllowedTools.Contains(tool.Name, StringComparer.Ordinal))
                    {
                        _logger.LogDebug("Skipping MCP tool {Tool} from {Server}: not in allow-list.", tool.Name, server.Name);
                        continue;
                    }

                    tools.Add(tool);
                }

                _logger.LogInformation("Connected to MCP server {Server}; {Count} tool(s) exposed to agents.", server.Name, tools.Count);
            }

            _tools = tools;
            return _tools;
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<McpClient> ConnectAsync(McpServerOptions server, CancellationToken cancellationToken)
    {
        IClientTransport transport;
        if (!string.IsNullOrWhiteSpace(server.Endpoint))
        {
            HttpClient httpClient = string.IsNullOrWhiteSpace(server.Scope)
                ? new HttpClient(new SocketsHttpHandler())
                : new HttpClient(new EntraBearerTokenHandler(_credential, server.Scope) { InnerHandler = new SocketsHttpHandler() });

            transport = new HttpClientTransport(new HttpClientTransportOptions
            {
                Endpoint = new Uri(server.Endpoint),
                Name = server.Name,
                TransportMode = HttpTransportMode.StreamableHttp,
                // Headless workflows only call tools; they do not need unsolicited server pushes.
                EnableStandaloneGetStream = false,
            }, httpClient, _loggerFactory);
        }
        else if (!string.IsNullOrWhiteSpace(server.Command))
        {
            transport = new StdioClientTransport(new StdioClientTransportOptions
            {
                Name = server.Name,
                Command = server.Command,
                Arguments = server.Arguments,
            }, _loggerFactory);
        }
        else
        {
            throw new InvalidOperationException($"MCP server '{server.Name}' must configure either Endpoint or Command.");
        }

        return await McpClient.CreateAsync(transport, loggerFactory: _loggerFactory, cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync()
    {
        foreach (McpClient client in _clients)
        {
            await client.DisposeAsync().ConfigureAwait(false);
        }

        _clients.Clear();
        _gate.Dispose();
    }
}
