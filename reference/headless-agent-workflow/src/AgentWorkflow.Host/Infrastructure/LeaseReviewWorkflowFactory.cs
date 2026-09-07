using AgentWorkflow.Core.Land;
using AgentWorkflow.Core.Mcp;
using AgentWorkflow.Core.Workflow;
using Microsoft.Extensions.AI;

namespace AgentWorkflow.Host.Infrastructure;

/// <summary>
/// Builds the Land team's lease review workflow. The analyst gets the land system's read tools only; the
/// operator gets the three write tools it needs to record the decision, open curative tasks, and set status.
/// </summary>
public sealed class LeaseReviewWorkflowFactory(IChatClient chatClient, McpToolSource tools) : IWorkflowFactory
{
    private static readonly HashSet<string> s_analystTools = new(StringComparer.OrdinalIgnoreCase)
    {
        "get_lease_metadata", "get_lease_document", "get_tract_title", "get_mineral_ownership", "get_lease_form_standards",
    };

    private static readonly HashSet<string> s_operatorTools = new(StringComparer.OrdinalIgnoreCase)
    {
        "record_lease_review", "create_curative_task", "update_lease_status",
    };

    public string Name => LeaseReviewWorkflow.Name;

    public async Task<Microsoft.Agents.AI.Workflows.Workflow> CreateAsync(CancellationToken cancellationToken = default)
    {
        IReadOnlyList<AITool> mcpTools = await tools.GetToolsAsync(cancellationToken);

        return LeaseReviewWorkflow.Build(
            LeaseReviewAgents.CreateLeaseAnalyst(chatClient, mcpTools.Where(t => s_analystTools.Contains(t.Name))),
            LeaseReviewAgents.CreateLandOperator(chatClient, mcpTools.Where(t => s_operatorTools.Contains(t.Name))));
    }
}
