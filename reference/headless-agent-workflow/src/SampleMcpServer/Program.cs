// A custom MCP server secured with Microsoft Entra ID, the way the Entra "Secure an MCP server" guidance
// describes: the server is an OAuth 2.0 protected resource, Entra is the authorization server, and the
// agent is a confidential client presenting an app-only token. Three things make that work:
//
//   1. JWT bearer validation of Entra v2 tokens (issuer, audience, signature) - Microsoft.Identity.Web.
//   2. Protected Resource Metadata (RFC 9728) served at /.well-known/oauth-protected-resource and referenced
//      from the WWW-Authenticate header of 401s - the MCP SDK's AddMcp() authentication handler.
//   3. Authorization by app role ("roles" claim) so only the workflow's identity can call tools.

using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Identity.Web;
using ModelContextProtocol.AspNetCore;
using ModelContextProtocol.AspNetCore.Authentication;
using SampleMcpServer.Tools;

var builder = WebApplication.CreateBuilder(args);

IConfigurationSection azureAd = builder.Configuration.GetSection("AzureAd");
string tenantId = azureAd["TenantId"] ?? throw new InvalidOperationException("AzureAd:TenantId is required.");
string resourceUri = builder.Configuration["Mcp:ResourceUri"]
    ?? throw new InvalidOperationException("Mcp:ResourceUri is required (the canonical HTTPS URL of this server, equal to the app registration's Application ID URI).");

AuthenticationBuilder auth = builder.Services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    // The MCP scheme issues the 401 challenge that points clients at the protected resource metadata.
    options.DefaultChallengeScheme = McpAuthenticationDefaults.AuthenticationScheme;
});

// Validates Entra tokens for this app registration. Audience must be the Application ID URI (the
// resource URL) so RFC 8707 resource indicators line up; Microsoft.Identity.Web maps the "roles" claim.
auth.AddMicrosoftIdentityWebApi(azureAd);

auth.AddMcp(options =>
{
    options.ResourceMetadata = new()
    {
        Resource = resourceUri,
        AuthorizationServers = { $"https://login.microsoftonline.com/{tenantId}/v2.0" },
        ScopesSupported = ["Tools.Read", "Tools.Execute"],
        BearerMethodsSupported = ["header"],
    };
});

builder.Services.AddAuthorization(options =>
{
    // App-only callers (the workflow's managed identity) carry app roles in "roles".
    // Delegated callers (a person in an IDE) carry scopes in "scp". Accept either.
    options.AddPolicy("McpRead", policy => policy.RequireAuthenticatedUser()
        .RequireAssertion(ctx => ctx.User.HasRoleOrScope("Tools.Read") || ctx.User.HasRoleOrScope("Tools.Execute")));
});

builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton<PurchaseOrderRepository>();
builder.Services
    .AddMcpServer()
    .WithHttpTransport(options =>
    {
        // Stateless mode lets the server scale horizontally without session affinity; the workflow
        // only calls tools and never needs server-to-client requests.
        options.SessionMode = HttpServerSessionMode.Stateless;
    })
    .WithTools<PurchaseOrderTools>();

WebApplication app = builder.Build();

app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/healthz", () => Results.Ok(new { status = "ok" })).AllowAnonymous();
app.MapMcp().RequireAuthorization("McpRead");

app.Run();

internal static class ClaimsPrincipalExtensions
{
    /// <summary>True when the caller has the given app role (app-only token) or delegated scope (user token).</summary>
    public static bool HasRoleOrScope(this System.Security.Claims.ClaimsPrincipal user, string name) =>
        user.IsInRole(name)
        || user.FindAll("roles").Any(c => c.Value == name)
        || user.FindAll("scp").Any(c => c.Value.Split(' ', StringSplitOptions.RemoveEmptyEntries).Contains(name));
}
