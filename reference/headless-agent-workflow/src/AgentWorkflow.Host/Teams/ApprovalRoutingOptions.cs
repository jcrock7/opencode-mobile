using AgentWorkflow.Core.Models;

namespace AgentWorkflow.Host.Teams;

/// <summary>Configuration section <c>Approvals</c>: who gets asked for which kind of case.</summary>
public sealed class ApprovalRoutingOptions
{
    /// <summary>Entra tenant of the approvers. Required by Teams for proactive conversations.</summary>
    public required string TenantId { get; set; }

    /// <summary>
    /// Teams service URL used when creating a conversation without a prior inbound activity.
    /// Public cloud: https://smba.trafficmanager.net/teams/ . Government clouds differ.
    /// </summary>
    public string ServiceUrl { get; set; } = "https://smba.trafficmanager.net/teams/";

    public ApprovalRoute Default { get; set; } = new();

    public List<ApprovalRoute> Routes { get; set; } = [];

    /// <summary>
    /// Most specific route wins: a route matching case type AND a trigger attribute (for example state = PA)
    /// beats a case-type-only route, which beats <see cref="Default"/>.
    /// </summary>
    public ApprovalRoute Resolve(DecisionRequest request)
    {
        var candidates = Routes.Where(r => string.Equals(r.CaseType, request.CaseType, StringComparison.OrdinalIgnoreCase)).ToList();

        ApprovalRoute? byAttribute = candidates.FirstOrDefault(r =>
            !string.IsNullOrWhiteSpace(r.Attribute)
            && request.Attributes is not null
            && request.Attributes.TryGetValue(r.Attribute, out string? value)
            && string.Equals(value, r.Value, StringComparison.OrdinalIgnoreCase));

        return byAttribute
            ?? candidates.FirstOrDefault(r => string.IsNullOrWhiteSpace(r.Attribute))
            ?? Default;
    }
}

public sealed class ApprovalRoute
{
    /// <summary>Case type this route applies to; null for the default route.</summary>
    public string? CaseType { get; set; }

    /// <summary>Optional trigger attribute name to match (for example "state" or "district").</summary>
    public string? Attribute { get; set; }

    /// <summary>Value the attribute must have for this route to apply (case-insensitive).</summary>
    public string? Value { get; set; }

    /// <summary>Entra object id of the approver. Used for a 1:1 chat, and as the on-behalf-of user for channel posts.</summary>
    public string? UserObjectId { get; set; }

    /// <summary>Teams channel id (19:...@thread.tacv2). When set the card is posted to the channel instead of a 1:1 chat.</summary>
    public string? TeamsChannelId { get; set; }
}
