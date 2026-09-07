using Azure.Core;

namespace AgentWorkflow.Core.Tests.Fakes;

public sealed class FakeTokenCredential(string token) : TokenCredential
{
    public List<string[]> RequestedScopes { get; } = [];

    public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken)
    {
        RequestedScopes.Add(requestContext.Scopes);
        return new AccessToken(token, DateTimeOffset.UtcNow.AddHours(1));
    }

    public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
        new(GetToken(requestContext, cancellationToken));
}
