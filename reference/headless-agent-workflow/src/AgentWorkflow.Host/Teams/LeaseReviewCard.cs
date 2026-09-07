using System.Text.Json.Nodes;
using AgentWorkflow.Core.Land;
using AgentWorkflow.Core.Models;
using AgentWorkflow.Core.Runtime;

namespace AgentWorkflow.Host.Teams;

/// <summary>
/// The lease sign-off card a landman sees: key terms, non-standard provisions, curative title work, and the
/// analyst's recommendation, with "Approve for execution" / "Return for revision" buttons. Same verb and data
/// contract as the generic card, so <see cref="DecisionAgent"/> handles both without special cases.
/// </summary>
public static class LeaseReviewCard
{
    private const int MaxListItems = 8;

    public static string BuildRequestCard(PendingDecision pending, LeaseReview review)
    {
        DecisionRequest request = pending.Request;
        LeaseKeyTerms t = review.KeyTerms;

        var body = new JsonArray
        {
            DecisionCard.TextBlock($"Lease sign-off: {review.LeaseId}", size: "Large", weight: "Bolder"),
            DecisionCard.TextBlock(
                $"{t.County} County, {t.State}  |  Title: {review.TitleStatus}  |  Risk: {request.Assessment.RiskLevel}  |  Requested {request.RequestedAt:yyyy-MM-dd HH:mm} UTC",
                isSubtle: true),
            DecisionCard.TextBlock(review.Summary),

            DecisionCard.TextBlock("Key terms", weight: "Bolder"),
            DecisionCard.FactSet(
                ("Lessor(s)", string.Join("; ", t.Lessors)),
                ("Lessee", t.Lessee),
                ("Legal", t.LegalDescription),
                ("Acres", $"{Fmt(t.GrossAcres)} gross / {Fmt(t.NetMineralAcres)} net mineral"),
                ("Primary term", t.PrimaryTerm + (string.IsNullOrWhiteSpace(t.ExtensionOption) ? "" : $"; extension: {t.ExtensionOption}")),
                ("Bonus", t.BonusConsideration),
                ("Royalty", t.RoyaltyRate + (string.IsNullOrWhiteSpace(t.RoyaltyDeductions) ? "" : $" ({t.RoyaltyDeductions})")),
                ("Depth", t.DepthLimitation ?? "All depths"),
                ("Pugh", t.PughClause ?? "None"),
                ("Pooling", t.PoolingProvision ?? "Not stated"),
                ("Continuous dev.", t.ContinuousDevelopmentClause ?? "None"),
                ("Surface", t.SurfaceUseProvisions ?? "Not stated"),
                ("Assignment", t.AssignmentRestrictions ?? "None")),
        };

        var nonStandard = review.NonStandardProvisions.ToList();
        body.Add(DecisionCard.TextBlock($"Provisions vs. standard form: {review.Provisions.Count - nonStandard.Count} standard, {nonStandard.Count} to review", weight: "Bolder"));
        body.Add(DecisionCard.TextBlock(nonStandard.Count == 0
            ? "All reviewed provisions match the company standard."
            : Bullets(nonStandard.Select(p => $"**{p.Provision}** ({p.Classification}): {p.Concern} Recommendation: {p.Recommendation}"))));

        body.Add(DecisionCard.TextBlock($"Curative title work: {review.CurativeItems.Count} item(s), {review.BlockingCurative.Count()} before execution", weight: "Bolder"));
        body.Add(DecisionCard.TextBlock(review.CurativeItems.Count == 0
            ? "No curative work identified."
            : Bullets(review.CurativeItems.Select(c => $"**{c.Category}** [{c.Timing}] {c.Description} Affected: {c.AffectedInterest}. Instrument: {c.RecommendedInstrument} ({c.ResponsibleParty})."))));

        body.Add(new JsonObject
        {
            ["type"] = "Container",
            ["style"] = "emphasis",
            ["items"] = new JsonArray
            {
                DecisionCard.TextBlock($"Analyst recommendation: {request.Assessment.Recommendation}", weight: "Bolder"),
                DecisionCard.TextBlock(request.Assessment.ProposedAction),
            },
        });

        body.Add(DecisionCard.TextBlock("Evidence", weight: "Bolder"));
        body.Add(DecisionCard.TextBlock(review.Evidence.Count == 0 ? "(none)" : Bullets(review.Evidence), isSubtle: true));

        body.Add(new JsonObject
        {
            ["type"] = "Input.Text",
            ["id"] = "comments",
            ["label"] = "Comments (optional)",
            ["isMultiline"] = true,
            ["placeholder"] = "Conditions, negotiation points, or the reason for returning the lease",
        });

        var card = new JsonObject
        {
            ["$schema"] = "http://adaptivecards.io/schemas/adaptive-card.json",
            ["type"] = "AdaptiveCard",
            ["version"] = "1.5",
            ["body"] = body,
            ["actions"] = new JsonArray
            {
                DecisionCard.Execute("Approve for execution", pending.RequestId, DecisionOutcome.Approved, style: "positive"),
                DecisionCard.Execute("Return for revision", pending.RequestId, DecisionOutcome.Rejected, style: "destructive"),
            },
        };

        return card.ToJsonString();
    }

    private static string Bullets(IEnumerable<string> items)
    {
        var list = items.ToList();
        IEnumerable<string> shown = list.Take(MaxListItems).Select(i => $"- {i}");
        string text = string.Join("\n\n", shown);
        return list.Count > MaxListItems ? text + $"\n\n- ... and {list.Count - MaxListItems} more (see the land system record)" : text;
    }

    private static string Fmt(double? acres) => acres is null ? "?" : acres.Value.ToString("0.###");
}
