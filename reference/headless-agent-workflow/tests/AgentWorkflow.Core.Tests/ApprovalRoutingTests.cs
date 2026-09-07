using AgentWorkflow.Core.Models;
using AgentWorkflow.Host.Teams;
using Xunit;

namespace AgentWorkflow.Core.Tests;

public sealed class ApprovalRoutingTests
{
    private static readonly ApprovalRoutingOptions s_options = new()
    {
        TenantId = "t",
        Default = new ApprovalRoute { UserObjectId = "default" },
        Routes =
        [
            new ApprovalRoute { CaseType = "LeaseReview", Attribute = "state", Value = "PA", UserObjectId = "pa-land-manager", TeamsChannelId = "19:pa@thread.tacv2" },
            new ApprovalRoute { CaseType = "LeaseReview", UserObjectId = "land-manager" },
            new ApprovalRoute { CaseType = "PurchaseOrderHold", UserObjectId = "ap-lead" },
        ],
    };

    private static DecisionRequest Request(string caseType, Dictionary<string, string>? attributes) =>
        new("c", caseType, new Assessment("s", "r", "why", "Low", [], "act"), DateTimeOffset.UtcNow, attributes);

    [Fact]
    public void Attribute_match_beats_case_type_only_route()
    {
        ApprovalRoute route = s_options.Resolve(Request("LeaseReview", new() { ["state"] = "pa" }));
        Assert.Equal("pa-land-manager", route.UserObjectId);
        Assert.Equal("19:pa@thread.tacv2", route.TeamsChannelId);
    }

    [Fact]
    public void Case_type_route_is_used_when_no_attribute_matches()
    {
        Assert.Equal("land-manager", s_options.Resolve(Request("LeaseReview", new() { ["state"] = "OH" })).UserObjectId);
        Assert.Equal("land-manager", s_options.Resolve(Request("LeaseReview", null)).UserObjectId);
    }

    [Fact]
    public void Unknown_case_type_falls_back_to_default()
    {
        Assert.Equal("default", s_options.Resolve(Request("Other", null)).UserObjectId);
    }
}
