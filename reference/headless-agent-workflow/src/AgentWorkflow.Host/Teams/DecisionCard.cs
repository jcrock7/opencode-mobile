using System.Text.Json;
using System.Text.Json.Nodes;
using AgentWorkflow.Core.Land;
using AgentWorkflow.Core.Models;
using AgentWorkflow.Core.Runtime;

namespace AgentWorkflow.Host.Teams;

/// <summary>
/// Adaptive Cards for the human decision. Action.Execute is used (not Action.Submit) so the card can be
/// replaced in place with a read-only "decided" version, and so the same card renders in Teams and Outlook.
/// </summary>
public static class DecisionCard
{
    /// <summary>Verb the host routes to the decision handler.</summary>
    public const string DecisionVerb = "workflow.decision";

    public sealed record DecisionAction(string RequestId, DecisionOutcome Outcome, string? Comments);

    public static string BuildRequestCard(PendingDecision pending)
    {
        // Workflow-specific cards render the detail payload; everything else falls back to the generic card.
        if (pending.Request.CaseType == LeaseReviewWorkflow.CaseType && pending.Request.TryGetDetail(out LeaseReview? review))
        {
            return LeaseReviewCard.BuildRequestCard(pending, review);
        }

        DecisionRequest request = pending.Request;
        Assessment a = request.Assessment;

        var body = new JsonArray
        {
            TextBlock($"Decision needed: {request.CaseType} {request.CaseId}", size: "Large", weight: "Bolder"),
            TextBlock($"Risk: {a.RiskLevel}  |  Requested {request.RequestedAt:yyyy-MM-dd HH:mm} UTC", isSubtle: true),
            FactSet(("Summary", a.Summary), ("Recommendation", a.Recommendation), ("Rationale", a.Rationale)),
            TextBlock("Evidence", weight: "Bolder"),
            TextBlock(a.Evidence.Count == 0 ? "(none)" : string.Join("\n\n", a.Evidence.Select(e => $"- {e}"))),
            new JsonObject
            {
                ["type"] = "Container",
                ["style"] = "emphasis",
                ["items"] = new JsonArray
                {
                    TextBlock("Proposed action", weight: "Bolder"),
                    TextBlock(a.ProposedAction),
                },
            },
            new JsonObject
            {
                ["type"] = "Input.Text",
                ["id"] = "comments",
                ["label"] = "Comments (optional)",
                ["isMultiline"] = true,
                ["placeholder"] = "Anything the record should capture about this decision",
            },
        };

        var card = new JsonObject
        {
            ["$schema"] = "http://adaptivecards.io/schemas/adaptive-card.json",
            ["type"] = "AdaptiveCard",
            ["version"] = "1.5",
            ["body"] = body,
            ["actions"] = new JsonArray
            {
                Execute("Approve", pending.RequestId, DecisionOutcome.Approved, style: "positive"),
                Execute("Reject", pending.RequestId, DecisionOutcome.Rejected, style: "destructive"),
            },
        };

        return card.ToJsonString();
    }

    public static string BuildDecidedCard(DecisionRequest request, Decision decision)
    {
        string outcome = decision.Outcome == DecisionOutcome.Approved ? "Approved" : "Rejected";
        var card = new JsonObject
        {
            ["$schema"] = "http://adaptivecards.io/schemas/adaptive-card.json",
            ["type"] = "AdaptiveCard",
            ["version"] = "1.5",
            ["body"] = new JsonArray
            {
                TextBlock($"{outcome}: {request.CaseType} {request.CaseId}", size: "Large", weight: "Bolder",
                    color: decision.Outcome == DecisionOutcome.Approved ? "Good" : "Attention"),
                FactSet(
                    ("Decided by", decision.DecidedBy),
                    ("Decided at", decision.DecidedAt.ToString("yyyy-MM-dd HH:mm 'UTC'")),
                    ("Comments", string.IsNullOrWhiteSpace(decision.Comments) ? "(none)" : decision.Comments),
                    ("Proposed action", request.Assessment.ProposedAction)),
                TextBlock(decision.Outcome == DecisionOutcome.Approved
                    ? "The agent is now carrying out the approved action. A result will be posted here."
                    : "No action will be taken.", isSubtle: true),
            },
        };
        return card.ToJsonString();
    }

    public static string BuildResultCard(WorkflowResult result)
    {
        var card = new JsonObject
        {
            ["$schema"] = "http://adaptivecards.io/schemas/adaptive-card.json",
            ["type"] = "AdaptiveCard",
            ["version"] = "1.5",
            ["body"] = new JsonArray
            {
                TextBlock($"Completed: {result.CaseId}", size: "Medium", weight: "Bolder"),
                FactSet(("Outcome", result.Outcome.ToString()), ("Decided by", result.DecidedBy), ("Summary", result.Summary)),
                TextBlock(result.ActionTaken is null ? "No action was taken." : $"Action taken: {result.ActionTaken}"),
            },
        };
        return card.ToJsonString();
    }

    /// <summary>Parses the <c>data</c> object delivered with an Action.Execute invoke.</summary>
    public static DecisionAction ParseAction(object data)
    {
        JsonElement element = data is JsonElement je ? je : JsonSerializer.SerializeToElement(data);

        string requestId = element.TryGetProperty("requestId", out JsonElement id) ? id.GetString() ?? "" : "";
        if (string.IsNullOrWhiteSpace(requestId))
        {
            throw new ArgumentException("Card action is missing requestId.");
        }

        if (!element.TryGetProperty("outcome", out JsonElement outcomeElement)
            || !Enum.TryParse(outcomeElement.GetString(), ignoreCase: true, out DecisionOutcome outcome))
        {
            throw new ArgumentException("Card action is missing a valid outcome.");
        }

        string? comments = element.TryGetProperty("comments", out JsonElement c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null;
        return new DecisionAction(requestId, outcome, string.IsNullOrWhiteSpace(comments) ? null : comments!.Trim());
    }

    internal static JsonObject Execute(string title, string requestId, DecisionOutcome outcome, string style) => new()
    {
        ["type"] = "Action.Execute",
        ["title"] = title,
        ["verb"] = DecisionVerb,
        ["style"] = style,
        // Input values (comments) are merged into this data object by the client.
        ["data"] = new JsonObject { ["requestId"] = requestId, ["outcome"] = outcome.ToString() },
    };

    internal static JsonObject TextBlock(string text, string? size = null, string? weight = null, bool isSubtle = false, string? color = null)
    {
        var block = new JsonObject { ["type"] = "TextBlock", ["text"] = text, ["wrap"] = true };
        if (size is not null) block["size"] = size;
        if (weight is not null) block["weight"] = weight;
        if (isSubtle) block["isSubtle"] = true;
        if (color is not null) block["color"] = color;
        return block;
    }

    internal static JsonObject FactSet(params (string Title, string Value)[] facts) => new()
    {
        ["type"] = "FactSet",
        ["facts"] = new JsonArray(facts.Select(f => (JsonNode)new JsonObject { ["title"] = f.Title, ["value"] = f.Value }).ToArray()),
    };
}
