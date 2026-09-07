namespace AgentWorkflow.Core.Mcp;

/// <summary>Configuration section <c>Mcp</c>.</summary>
public sealed class McpOptions
{
    public List<McpServerOptions> Servers { get; set; } = [];
}

/// <summary>One MCP server the agents may use.</summary>
public sealed class McpServerOptions
{
    /// <summary>Friendly name used for logging and tool attribution.</summary>
    public required string Name { get; set; }

    /// <summary>HTTPS endpoint of a remote (Streamable HTTP) MCP server. Mutually exclusive with <see cref="Command"/>.</summary>
    public string? Endpoint { get; set; }

    /// <summary>
    /// Entra ID scope requested for the server, for example <c>api://{mcp-app-id}/.default</c>.
    /// When set, every request carries a bearer token acquired with the workflow's own identity.
    /// </summary>
    public string? Scope { get; set; }

    /// <summary>Local stdio server command (development only). Mutually exclusive with <see cref="Endpoint"/>.</summary>
    public string? Command { get; set; }

    public List<string> Arguments { get; set; } = [];

    /// <summary>Optional allow-list. When non-empty only these tool names are exposed to agents.</summary>
    public List<string> AllowedTools { get; set; } = [];
}
