using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using AgentWorkflow.Core.Runtime;

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
/// The common decision surface every workflow produces for a human. Keep every field a string or
/// list so the JSON schema handed to the model stays simple and provider-neutral. Workflow-specific
/// detail (a full lease review, an invoice breakdown) travels in <see cref="DecisionRequest.Detail"/>.
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
/// <param name="Attributes">Trigger attributes (state, district, business unit) used for approver routing.</param>
/// <param name="Detail">Workflow-specific structured payload rendered on the card and handed to the apply step.</param>
public sealed record DecisionRequest(
    string CaseId,
    string CaseType,
    Assessment Assessment,
    DateTimeOffset RequestedAt,
    Dictionary<string, string>? Attributes = null,
    JsonElement? Detail = null)
{
    /// <summary>Creates a request carrying a typed detail payload.</summary>
    public static DecisionRequest Create<TDetail>(
        string caseId,
        string caseType,
        Assessment assessment,
        TDetail detail,
        Dictionary<string, string>? attributes = null) =>
        new(caseId, caseType, assessment, DateTimeOffset.UtcNow, attributes,
            JsonSerializer.SerializeToElement(detail, WorkflowJson.CheckpointOptions));

    /// <summary>Reads the detail payload back as <typeparamref name="TDetail"/>.</summary>
    public bool TryGetDetail<TDetail>([NotNullWhen(true)] out TDetail? detail) where TDetail : class
    {
        detail = null;
        if (Detail is not { ValueKind: JsonValueKind.Object } element)
        {
            return false;
        }

        try
        {
            detail = element.Deserialize<TDetail>(WorkflowJson.CheckpointOptions);
            return detail is not null;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}

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
