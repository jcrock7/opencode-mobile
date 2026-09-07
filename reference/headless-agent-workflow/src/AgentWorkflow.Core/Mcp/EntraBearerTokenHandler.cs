using System.Net.Http.Headers;
using Azure.Core;

namespace AgentWorkflow.Core.Mcp;

/// <summary>
/// Attaches an Entra ID access token to every outbound MCP request.
/// The token is acquired with the workflow's own identity (managed identity in Azure), so the MCP
/// server sees the agent as an application principal and can authorize it with app roles.
/// <see cref="TokenCredential"/> implementations cache tokens, so calling GetTokenAsync per request is cheap.
/// </summary>
public sealed class EntraBearerTokenHandler : DelegatingHandler
{
    private readonly TokenCredential _credential;
    private readonly string[] _scopes;

    public EntraBearerTokenHandler(TokenCredential credential, string scope)
    {
        ArgumentNullException.ThrowIfNull(credential);
        ArgumentException.ThrowIfNullOrWhiteSpace(scope);
        _credential = credential;
        _scopes = [scope];
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        AccessToken token = await _credential.GetTokenAsync(new TokenRequestContext(_scopes), cancellationToken).ConfigureAwait(false);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);
        return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
    }
}
