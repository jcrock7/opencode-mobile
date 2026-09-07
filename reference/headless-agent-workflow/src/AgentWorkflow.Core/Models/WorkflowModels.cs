namespace AgentWorkflow.Core.Models;

/// <summary>
/// The event that starts a workflow run. Produced by a headless trigger
/// (timer, queue message, ERP webhook, HTTP call) - never by a chat message.
/// </summary>
public sealed record WorkflowTrigger(
    string CaseId,
    string CaseType,
    string Description,
    string? RequestedBy = null,
    Dictionary<string, string>? Attributes = null);

/// <summary>
/// Structured output the analyst agent must produce. Keep every field a string or
/// list so the JSON schema handed to the model stays simple and provider-neutral.
/// </summary>
public sealed record Assessment(
    string Summary,
    string Recommendation,
    string Rationale,
    string RiskLevel,
    IReadOnlyList<string> Evidence,
    string ProposedAction);

/// <summary>
/// What is sent to a human. This is the request type of the workflow's RequestPort,
/// so it is persisted inside the checkpoint while the human takes their time.
/// </summary>
public sealed record DecisionRequest(
    string CaseId,
    string CaseType,
    Assessment Assessment,
    DateTimeOffset RequestedAt);

public enum DecisionOutcome
{
    Approved,
    Rejected,
}

/// <summary>
/// The human's answer. It carries the original <see cref="DecisionRequest"/> so the
/// downstream executor is self-contained and does not need shared workflow state.
/// </summary>
public sealed record Decision(
    DecisionRequest Request,
    DecisionOutcome Outcome,
    string DecidedBy,
    string? Comments,
    DateTimeOffset DecidedAt);

/// <summary>Structured output of the operator agent after it carries out an approved action.</summary>
public sealed record ActionReport(bool Succeeded, string Summary);

/// <summary>Final workflow output.</summary>
public sealed record WorkflowResult(
    string CaseId,
    DecisionOutcome Outcome,
    string DecidedBy,
    string Summary,
    string? ActionTaken);
