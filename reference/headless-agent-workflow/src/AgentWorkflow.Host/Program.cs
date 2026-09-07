// Headless agentic workflow host.
//
// Two Microsoft SDKs share this process, and it helps to keep their roles straight:
//   * Microsoft Agent Framework (Microsoft.Agents.AI.*) - the orchestrator. Runs the agents, calls MCP tools,
//     owns the workflow graph, pauses at the human-decision port, checkpoints, resumes.
//   * Microsoft 365 Agents SDK (Microsoft.Agents.Hosting/Builder/Core) - the Teams channel. Validates inbound
//     Teams traffic, sends proactive Adaptive Cards, receives the Approve/Reject click.

using System.ClientModel.Primitives;
using AgentWorkflow.Core.Mcp;
using AgentWorkflow.Core.Runtime;
using AgentWorkflow.Core.Workflow;
using AgentWorkflow.Host;
using AgentWorkflow.Host.Infrastructure;
using AgentWorkflow.Host.Teams;
using AgentWorkflow.Host.Triggers;
using Azure.Core;
using Microsoft.Agents.AI.Workflows;
using Microsoft.Agents.AI.Workflows.Checkpointing;
using Microsoft.Agents.Hosting.AspNetCore;
using Microsoft.Agents.Storage;
using Microsoft.Agents.Storage.Blobs;
using Microsoft.Extensions.AI;
using OpenAI;

WebApplicationBuilder builder = WebApplication.CreateBuilder(args);
IConfiguration config = builder.Configuration;
bool isDev = builder.Environment.IsDevelopment();

// ---------------------------------------------------------------------------------------------
// 1. Microsoft 365 Agents SDK: Teams endpoint (/api/messages), inbound JWT validation, MSAL outbound auth
// ---------------------------------------------------------------------------------------------
builder.AddAgentDefaults()
    .AddAgent<DecisionAgent>()
    // AspNetExtensions.cs (copied from the Microsoft sample) validates Azure Bot Service / Entra tokens
    // using the "TokenValidation" section: Audiences = [agent app id], TenantId.
    .AddAgentAuthorization(b => b.AddAgentAspNetAuthentication());

// Conversation references for proactive messages must outlive the process. Blob storage in Azure; memory locally.
string? storageConnection = config["Storage:BlobConnectionString"];
if (!string.IsNullOrWhiteSpace(storageConnection))
{
    builder.Services.AddSingleton<IStorage>(new BlobsStorage(storageConnection, config["Storage:BlobContainer"] ?? "agent-state"));
}
else
{
    builder.Services.AddSingleton<IStorage, MemoryStorage>();
}

// ---------------------------------------------------------------------------------------------
// 2. Identity: one credential for Azure OpenAI and every MCP server
// ---------------------------------------------------------------------------------------------
builder.Services.AddSingleton<TokenCredential>(_ => AzureIdentity.Create(config));

// ---------------------------------------------------------------------------------------------
// 3. Model: Azure OpenAI through the OpenAI SDK v1 endpoint, Entra token, no API keys
// ---------------------------------------------------------------------------------------------
builder.Services.AddSingleton<IChatClient>(sp =>
{
    string endpoint = config["AzureOpenAI:Endpoint"] ?? throw new InvalidOperationException("AzureOpenAI:Endpoint is required.");
    string deployment = config["AzureOpenAI:Deployment"] ?? throw new InvalidOperationException("AzureOpenAI:Deployment is required.");
    string scope = config["AzureOpenAI:Scope"] ?? "https://ai.azure.com/.default";

    var client = new OpenAIClient(
        new BearerTokenPolicy(sp.GetRequiredService<TokenCredential>(), scope),
        new OpenAIClientOptions { Endpoint = new Uri(endpoint.TrimEnd('/') + "/openai/v1/") });

    return client.GetChatClient(deployment).AsIChatClient();
});

// ---------------------------------------------------------------------------------------------
// 4. MCP: your custom servers, called with the workflow's identity
// ---------------------------------------------------------------------------------------------
builder.Services.Configure<McpOptions>(config.GetSection("Mcp"));
builder.Services.AddSingleton<McpToolSource>();

// ---------------------------------------------------------------------------------------------
// 5. Agent Framework workflow runtime: graph factory, checkpoints, pending decisions, Teams channel
// ---------------------------------------------------------------------------------------------
// One factory per workflow hosted here. Each becomes a WorkflowRunner addressed by its Name.
builder.Services.AddSingleton<IWorkflowFactory, HumanDecisionWorkflowFactory>();   // purchasing sample
builder.Services.AddSingleton<IWorkflowFactory, LeaseReviewWorkflowFactory>();     // Land team: pre-execution lease review

builder.Services.AddSingleton<CheckpointManager>(_ =>
{
    // File system is fine for one instance. For several instances implement JsonCheckpointStore over
    // Cosmos DB / SQL / Blob (see docs/architecture.md); the runtime does not change.
    string dir = config["Workflow:CheckpointDirectory"] ?? Path.Combine(AppContext.BaseDirectory, ".state", "checkpoints");
    return CheckpointManager.CreateJson(new FileSystemJsonCheckpointStore(new DirectoryInfo(dir)), WorkflowJson.CheckpointOptions);
});

builder.Services.AddSingleton<IPendingDecisionStore>(_ =>
    new FilePendingDecisionStore(config["Workflow:PendingDecisionDirectory"] ?? Path.Combine(AppContext.BaseDirectory, ".state", "pending")));

builder.Services.Configure<ApprovalRoutingOptions>(config.GetSection("Approvals"));
builder.Services.AddSingleton<IDecisionChannel, TeamsDecisionChannel>();
builder.Services.AddSingleton<WorkflowRunnerRegistry>(sp => new WorkflowRunnerRegistry(
    sp.GetServices<IWorkflowFactory>().Select(factory => new WorkflowRunner(
        factory,
        sp.GetRequiredService<CheckpointManager>(),
        sp.GetRequiredService<IPendingDecisionStore>(),
        sp.GetRequiredService<IDecisionChannel>(),
        sp.GetRequiredService<ILogger<WorkflowRunner>>()))));

// ---------------------------------------------------------------------------------------------
// 6. Headless triggers
// ---------------------------------------------------------------------------------------------
builder.Services.Configure<ScheduleOptions>(config.GetSection("Triggers:Schedule"));
builder.Services.AddSingleton<IWorkflowTriggerSource, ConfigurationTriggerSource>();
builder.Services.AddHostedService<ScheduledTriggerService>();

WebApplication app = builder.Build();

app.UseAgents();                 // authentication + authorization middleware for the Agents SDK endpoints
app.MapDefaultAgentEndpoints();  // GET / and POST /api/messages (Teams)
app.MapWorkflowTriggerEndpoints(requireAuth: !isDev);
app.MapGet("/healthz", () => Results.Ok(new { status = "ok" })).AllowAnonymous();

app.Run();

public partial class Program;
