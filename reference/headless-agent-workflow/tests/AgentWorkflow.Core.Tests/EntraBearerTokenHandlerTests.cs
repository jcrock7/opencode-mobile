using System.Net;
using AgentWorkflow.Core.Mcp;
using AgentWorkflow.Core.Tests.Fakes;
using Xunit;

namespace AgentWorkflow.Core.Tests;

public sealed class EntraBearerTokenHandlerTests
{
    private sealed class CapturingHandler : HttpMessageHandler
    {
        public HttpRequestMessage? Last { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Last = request;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
        }
    }

    [Fact]
    public async Task Adds_a_bearer_token_for_the_configured_scope()
    {
        var credential = new FakeTokenCredential("token-123");
        var inner = new CapturingHandler();
        using var client = new HttpClient(new EntraBearerTokenHandler(credential, "api://mcp-app/.default") { InnerHandler = inner });

        await client.GetAsync("https://mcp.contoso.com/");

        Assert.Equal("Bearer", inner.Last!.Headers.Authorization!.Scheme);
        Assert.Equal("token-123", inner.Last.Headers.Authorization.Parameter);
        Assert.Equal(["api://mcp-app/.default"], credential.RequestedScopes.Single());
    }
}
