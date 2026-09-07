using Azure.Core;
using Azure.Identity;

namespace AgentWorkflow.Host.Infrastructure;

/// <summary>
/// One workload identity for everything the workflow calls: Azure OpenAI, your MCP servers, storage.
/// Picks an explicit credential per environment instead of DefaultAzureCredential's probing chain in production.
/// Configuration section <c>Identity</c>: Mode = ManagedIdentity | WorkloadIdentity | Development.
/// </summary>
public static class AzureIdentity
{
    public static TokenCredential Create(IConfiguration configuration)
    {
        IConfigurationSection section = configuration.GetSection("Identity");
        string mode = section["Mode"] ?? "Development";
        string? clientId = section["ManagedIdentityClientId"];

        return mode switch
        {
            // App Service, Container Apps, Functions, VMs: no secrets anywhere.
            "ManagedIdentity" => string.IsNullOrWhiteSpace(clientId)
                ? new ManagedIdentityCredential(ManagedIdentityId.SystemAssigned)
                : new ManagedIdentityCredential(ManagedIdentityId.FromUserAssignedClientId(clientId)),

            // AKS with Entra Workload ID (federated token file).
            "WorkloadIdentity" => new WorkloadIdentityCredential(),

            // Developer machine: az login / Visual Studio / VS Code sign-in. Never used in Azure.
            _ => new DefaultAzureCredential(new DefaultAzureCredentialOptions
            {
                ExcludeInteractiveBrowserCredential = true,
                ExcludeManagedIdentityCredential = true,
            }),
        };
    }
}
