using AgentWorkflow.Core.Agents;
using AgentWorkflow.Core.Mcp;
using AgentWorkflow.Core.Workflow;
using Microsoft.Extensions.AI;

namespace AgentWorkflow.Host.Infrastructure;

/// <summary>
/// Builds the purchasing reference workflow with agents that carry the MCP tools. Called for every start and
/// resume, so each run gets an identical graph (required for checkpoint rehydration).
/// Tools are granted by explicit name: the analyst sees only purchasing read tools, the operator only the release tool.
/// </summary>
public sealed class HumanDecisionWorkflowFactory(IChatClient chatClient, McpToolSource tools) : IWorkflowFactory
{
    private static readonly HashSet<string> s_analystTools = new(StringComparer.OrdinalIgnoreCase)
    {
        "get_purchase_order", "list_held_purchase_orders", "get_vendor_profile",
    };

    private static readonly HashSet<string> s_operatorTools = new(StringComparer.OrdinalIgnoreCase)
    {
        "release_purchase_order_hold",
    };

    public string Name => HumanDecisionWorkflow.Name;

    public async Task<Microsoft.Agents.AI.Workflows.Workflow> CreateAsync(CancellationToken cancellationToken = default)
    {
        IReadOnlyList<AITool> mcpTools = await tools.GetToolsAsync(cancellationToken);

        return HumanDecisionWorkflow.Build(
            WorkflowAgents.CreateAnalyst(chatClient, mcpTools.Where(t => s_analystTools.Contains(t.Name))),
            WorkflowAgents.CreateOperator(chatClient, mcpTools.Where(t => s_operatorTools.Contains(t.Name))));
    }
}
