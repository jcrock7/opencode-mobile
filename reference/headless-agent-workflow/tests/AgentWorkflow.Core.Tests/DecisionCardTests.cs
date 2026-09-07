using System.Text.Json;
using AgentWorkflow.Core.Models;
using AgentWorkflow.Core.Runtime;
using AgentWorkflow.Host.Teams;
using Xunit;

namespace AgentWorkflow.Core.Tests;

public sealed class DecisionCardTests
{
    private static readonly PendingDecision s_pending = new(
        "req-42", "HumanDecision", "sess-1", "cp-1", "HumanDecision",
        new DecisionRequest("PO-1001", "PurchaseOrderHold",
            new Assessment("Hold caused by bank change.", "Release the hold", "Verified in vendor master.", "Medium",
                ["get_purchase_order: BANK_CHANGE"], "Release the payment hold on PO-1001"),
            DateTimeOffset.UtcNow),
        DateTimeOffset.UtcNow, null);

    [Fact]
    public void Request_card_carries_the_request_id_and_both_actions()
    {
        JsonElement card = JsonDocument.Parse(DecisionCard.BuildRequestCard(s_pending)).RootElement;

        Assert.Equal("AdaptiveCard", card.GetProperty("type").GetString());
        string json = card.GetRawText();
        Assert.Contains("\"verb\":\"" + DecisionCard.DecisionVerb + "\"", json.Replace(" ", ""));
        Assert.Contains("req-42", json);
        Assert.Contains("Release the payment hold on PO-1001", json);
        Assert.Contains("\"Approved\"", json);
        Assert.Contains("\"Rejected\"", json);
    }

    [Fact]
    public void Action_payload_parses_into_a_decision_action()
    {
        var data = JsonDocument.Parse("""{"requestId":"req-42","outcome":"Approved","comments":"ok"}""").RootElement;

        DecisionCard.DecisionAction action = DecisionCard.ParseAction(data);

        Assert.Equal("req-42", action.RequestId);
        Assert.Equal(DecisionOutcome.Approved, action.Outcome);
        Assert.Equal("ok", action.Comments);
    }

    [Fact]
    public void Decided_card_is_read_only()
    {
        var decision = new Decision(s_pending.Request, DecisionOutcome.Rejected, "jane", "no", DateTimeOffset.UtcNow);
        JsonElement card = JsonDocument.Parse(DecisionCard.BuildDecidedCard(s_pending.Request, decision)).RootElement;

        Assert.False(card.TryGetProperty("actions", out _));
        Assert.Contains("Rejected", card.GetRawText());
    }
}
