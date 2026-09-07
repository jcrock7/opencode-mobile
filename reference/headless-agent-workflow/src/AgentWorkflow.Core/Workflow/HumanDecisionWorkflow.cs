using AgentWorkflow.Core.Models;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Workflows;

namespace AgentWorkflow.Core.Workflow;

/// <summary>
/// The reference graph:
/// <code>
///   WorkflowTrigger -> [Assess (analyst agent + MCP)] -> DecisionRequest
///                   -> [RequestPort "HumanDecision"]   (workflow halts here, checkpoint persisted)
///                   -> Decision -> [ApplyDecision (operator agent + MCP)] -> WorkflowResult
/// </code>
/// To build a new workflow, keep the port and swap the executors and message types.
/// </summary>
public static class HumanDecisionWorkflow
{
    public const string Name = "HumanDecision";
    public const string DecisionPortId = "HumanDecision";

    public static Microsoft.Agents.AI.Workflows.Workflow Build(AIAgent analyst, AIAgent operatorAgent)
    {
        var assess = new AssessExecutor(analyst);
        RequestPort<DecisionRequest, Decision> humanDecision = RequestPort.Create<DecisionRequest, Decision>(DecisionPortId);
        var apply = new ApplyDecisionExecutor(operatorAgent);

        return new WorkflowBuilder(assess)
            .WithName(Name)
            .WithDescription("Agent assesses a case, a human decides in Teams, the agent applies the approved action.")
            .AddEdge(assess, humanDecision)
            .AddEdge(humanDecision, apply)
            .WithOutputFrom(apply)
            .Build();
    }
}

/// <summary>
/// Creates a fresh <see cref="Microsoft.Agents.AI.Workflows.Workflow"/> instance for each run or resume.
/// A rehydrated run must be built from an identical graph (same executor ids), which is why the
/// runtime asks a factory instead of holding one workflow instance.
/// </summary>
public interface IWorkflowFactory
{
    Task<Microsoft.Agents.AI.Workflows.Workflow> CreateAsync(CancellationToken cancellationToken = default);
}
