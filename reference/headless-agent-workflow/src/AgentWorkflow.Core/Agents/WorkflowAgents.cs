using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

namespace AgentWorkflow.Core.Agents;

/// <summary>
/// Builds the two agents used by the reference workflow.
/// Agents get stable <c>Id</c>/<c>Name</c> values: Agent Framework derives executor identity from them,
/// and checkpoints only rehydrate when identities match the run that created them.
/// </summary>
public static class WorkflowAgents
{
    public const string AnalystId = "case-analyst";
    public const string OperatorId = "case-operator";

    public static AIAgent CreateAnalyst(IChatClient chatClient, IEnumerable<AITool> tools) =>
        new ChatClientAgent(chatClient, new ChatClientAgentOptions
        {
            Id = AnalystId,
            Name = "CaseAnalyst",
            Description = "Investigates a case using enterprise MCP tools and produces a recommendation for a human.",
            ChatOptions = new ChatOptions
            {
                Instructions =
                    """
                    You are an analyst supporting a human decision maker.
                    Use the available tools to gather the facts about the case you are given.
                    Never take an action that changes data; only read.
                    Produce a concise assessment: what you found, the risk level (Low, Medium, High),
                    a clear recommendation, the evidence you relied on, and the single proposed action
                    a human could approve. Be specific and cite tool results as evidence.
                    """,
                Tools = [.. tools],
            },
        });

    public static AIAgent CreateOperator(IChatClient chatClient, IEnumerable<AITool> tools) =>
        new ChatClientAgent(chatClient, new ChatClientAgentOptions
        {
            Id = OperatorId,
            Name = "CaseOperator",
            Description = "Carries out an action that a human has explicitly approved, using enterprise MCP tools.",
            ChatOptions = new ChatOptions
            {
                Instructions =
                    """
                    You carry out exactly one action that a human has approved.
                    Use the available tools to perform the approved action and nothing else.
                    If the tools do not allow the action, do not improvise; report that it could not be done.
                    Report what you did and whether it succeeded.
                    """,
                Tools = [.. tools],
            },
        });
}
