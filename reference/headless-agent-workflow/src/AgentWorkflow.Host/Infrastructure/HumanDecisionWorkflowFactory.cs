using AgentWorkflow.Core.Agents;
using AgentWorkflow.Core.Mcp;
using AgentWorkflow.Core.Workflow;
using Microsoft.Extensions.AI;

namespace AgentWorkflow.Host.Infrastructure;

/// <summary>
/// Builds the reference workflow with agents that carry the MCP tools. Called for every start and resume,
/// so each run gets an identical graph (required for checkpoint rehydration).
/// </summary>
public sealed class HumanDecisionWorkflowFactory(IChatClient chatClient, McpToolSource tools) : IWorkflowFactory
{
    public async Task<Microsoft.Agents.AI.Workflows.Workflow> CreateAsync(CancellationToken cancellationToken = default)
    {
        IReadOnlyList<AITool> mcpTools = await tools.GetToolsAsync(cancellationToken);

        // Least privilege per agent: the analyst only sees read tools, the operator only the write tool it needs.
        var readTools = mcpTools.Where(t => !IsWriteTool(t.Name)).ToList();
        var writeTools = mcpTools.Where(t => IsWriteTool(t.Name)).ToList();

        return HumanDecisionWorkflow.Build(
            WorkflowAgents.CreateAnalyst(chatClient, readTools),
            WorkflowAgents.CreateOperator(chatClient, writeTools));
    }

    private static bool IsWriteTool(string name) =>
        name.StartsWith("release_", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith("update_", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith("create_", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith("delete_", StringComparison.OrdinalIgnoreCase);
}
