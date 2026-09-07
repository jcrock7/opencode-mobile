using AgentWorkflow.Core.Land;
using AgentWorkflow.Core.Models;
using AgentWorkflow.Core.Runtime;
using AgentWorkflow.Core.Tests.Fakes;
using AgentWorkflow.Core.Workflow;
using AgentWorkflow.Host.Teams;
using Microsoft.Agents.AI.Workflows;
using Microsoft.Agents.AI.Workflows.Checkpointing;
using Microsoft.Extensions.AI;
using Xunit;

namespace AgentWorkflow.Core.Tests;

/// <summary>
/// Land team lease review: analyst review -> landman sign-off in Teams -> record + curative tasks.
/// Same headless cycle as the purchasing sample, with a rich detail payload that must survive the checkpoint.
/// </summary>
public sealed class LeaseReviewWorkflowTests : IDisposable
{
    /// <summary>What the lease analyst would return for the sample tract (camelCase, as the model would).</summary>
    internal const string LeaseReviewJson =
        """
        {
          "leaseId": "L-2026-0142",
          "keyTerms": {
            "lessors": ["John A. Miller", "Mary E. Miller"],
            "lessee": "Contoso Energy LLC",
            "legalDescription": "Tax Parcel 020-004-00-00-0012-00, Amwell Township; Deed Book 3456, Page 221",
            "county": "Washington",
            "state": "PA",
            "grossAcres": 118.42,
            "netMineralAcres": 88.815,
            "primaryTerm": "5 years",
            "bonusConsideration": "$3,500 per net mineral acre, paid-up",
            "royaltyRate": "18% of gross proceeds",
            "effectiveDate": "2026-09-15",
            "delayRental": "None (paid-up)",
            "shutInRoyalty": "$10 per net mineral acre per year, max 2 consecutive years",
            "extensionOption": "One 3-year extension at the original bonus rate",
            "depthLimitation": "Surface to base of Marcellus; Utica/Point Pleasant reserved to Lessor",
            "pughClause": "Horizontal at end of primary term; vertical 100 ft below deepest producing formation",
            "poolingProvision": "Units up to 640 acres + 10%; consent required above",
            "continuousDevelopmentClause": "180 days between completion and next commencement",
            "surfaceUseProvisions": "No surface operations",
            "royaltyDeductions": "Cost-free; no post-production deductions",
            "assignmentRestrictions": "Lessor consent required except affiliates and financing",
            "warrantyOfTitle": "Warranty limited to the 3/4 interest described",
            "otherNotableTerms": ["Favored nations within Amwell Township for 12 months", "Annual audit right"]
          },
          "provisions": [
            { "provision": "Royalty deductions", "leaseLanguage": "free of all costs of gathering ... marketing", "classification": "NonStandard", "concern": "Cost-free royalty at 18% exceeds the standard economic position.", "recommendation": "Escalate to Land Manager; negotiate deductions or a lower rate." },
            { "provision": "Depth limitation", "leaseLanguage": "surface to base of Marcellus; deeper formations reserved", "classification": "NonStandard", "concern": "Utica reservation forfeits deep rights on a prospective tract.", "recommendation": "Negotiate all depths or price the concession with Reservoir Engineering." },
            { "provision": "Continuous development", "leaseLanguage": "no more than 180 days between wells", "classification": "NonStandard", "concern": "Operationally difficult; standard is 365 days.", "recommendation": "Negotiate to 365 days." },
            { "provision": "Favored nations", "leaseLanguage": "same royalty or bonus granted within Amwell Township within 12 months", "classification": "NonStandard", "concern": "Company does not accept favored-nations clauses.", "recommendation": "Strike." },
            { "provision": "Primary term", "leaseLanguage": "five (5) years with one 3-year extension", "classification": "Standard", "concern": "", "recommendation": "Accept." },
            { "provision": "Pooling", "leaseLanguage": "640 acres plus 10%", "classification": "Standard", "concern": "", "recommendation": "Accept." }
          ],
          "curativeItems": [
            { "category": "Heirship", "description": "1/4 interest retained by Robert L. Miller (d. 2011, intestate, no probate) is not vested in the lessors.", "affectedInterest": "0.25 of 118.42 acres (29.605 NMA)", "timing": "BeforeExecution", "recommendedInstrument": "Affidavit of Heirship, then leases from Susan Miller Kline and David R. Miller", "responsibleParty": "Landman / broker" },
            { "category": "UnreleasedPriorLease", "description": "1998 lease to Appalachian Gas Co. has no release of record; no production found.", "affectedInterest": "Entire tract", "timing": "BeforeExecution", "recommendedInstrument": "Release of Oil and Gas Lease or Affidavit of Non-Production", "responsibleParty": "Landman" },
            { "category": "MortgageSubordination", "description": "2019 mortgage to First Federal Savings Bank covers the oil and gas.", "affectedInterest": "Lessors' 3/4 interest", "timing": "BeforeDrilling", "recommendedInstrument": "Subordination Agreement", "responsibleParty": "Land / lender" },
            { "category": "NpriRatification", "description": "1/32 NPRI reserved to Samuel Kern (1957) burdens the royalty; ratification needed to pool.", "affectedInterest": "0.03125 NPRI", "timing": "BeforeDrilling", "recommendedInstrument": "Ratification of Oil and Gas Lease", "responsibleParty": "Landman" },
            { "category": "NameVariance", "description": "Deed grantee 'Mary Ellen Miller' vs lease signatory 'Mary E. Miller'.", "affectedInterest": "Lessors' 3/4 interest", "timing": "PostExecution", "recommendedInstrument": "Affidavit of Identity (AKA)", "responsibleParty": "Landman" }
          ],
          "titleStatus": "CurativeRequired",
          "recommendation": "ReturnForRevision",
          "summary": "Four non-standard provisions (cost-free 18% royalty, Marcellus-only depth limitation, 180-day continuous development, favored nations) and two curative items that must be cured before execution (unadministered estate holding 1/4, unreleased 1998 lease). Recommend returning the draft to the broker with negotiation points and starting heirship curative now.",
          "evidence": [
            "get_lease_document DOC-88213: paragraphs 4, 7, 9, 14",
            "get_lease_form_standards: royalty deductions, depth limitation, continuous development, favored nations positions",
            "get_tract_title T-3391: 1998 OGL 412/88 no release; MB 991/1502 open mortgage; 1957 NPRI 1102/77; estate note 2011",
            "get_mineral_ownership T-3391: lessors 0.75, heirs of Robert L. Miller 0.25, Kern NPRI 0.03125"
          ]
        }
        """;

    private const string RecordReportJson =
        """
        {"succeeded":true,"summary":"Recorded review REV-0001 as ApprovedForExecution; created curative tasks CUR-0001..CUR-0005; lease L-2026-0142 status set to ApprovedForExecution.","curativeTaskIds":["CUR-0001","CUR-0002","CUR-0003","CUR-0004","CUR-0005"]}
        """;

    private const string ReturnReportJson =
        """
        {"succeeded":true,"summary":"Recorded review REV-0001 as ReturnedForRevision with the land manager's comments; lease status unchanged.","curativeTaskIds":[]}
        """;

    private static readonly WorkflowTrigger s_trigger = new(
        "L-2026-0142",
        LeaseReviewWorkflow.CaseType,
        "Draft lease received from Keystone Land Services for pre-execution review.",
        RequestedBy: "land-system",
        Attributes: new Dictionary<string, string> { ["state"] = "PA", ["county"] = "Washington", ["tractId"] = "T-3391" });

    private readonly string _dir = Path.Combine(Path.GetTempPath(), "agent-workflow-tests", Guid.NewGuid().ToString("N"));

    private sealed class TestFactory(IChatClient chatClient) : IWorkflowFactory
    {
        public string Name => LeaseReviewWorkflow.Name;

        public Task<Microsoft.Agents.AI.Workflows.Workflow> CreateAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(LeaseReviewWorkflow.Build(
                LeaseReviewAgents.CreateLeaseAnalyst(chatClient, []),
                LeaseReviewAgents.CreateLandOperator(chatClient, [])));
    }

    private (WorkflowRunner Runner, FileSystemJsonCheckpointStore Store) CreateRunner(IChatClient chat, IPendingDecisionStore pending, IDecisionChannel channel)
    {
        var store = new FileSystemJsonCheckpointStore(new DirectoryInfo(Path.Combine(_dir, "checkpoints")));
        var manager = CheckpointManager.CreateJson(store, WorkflowJson.CheckpointOptions);
        return (new WorkflowRunner(new TestFactory(chat), manager, pending, channel), store);
    }

    [Fact]
    public async Task Review_halts_for_the_landman_with_the_full_lease_review_attached()
    {
        var chat = new ScriptedChatClient(LeaseReviewJson);
        var pendingStore = new FilePendingDecisionStore(Path.Combine(_dir, "pending"));
        var channel = new RecordingDecisionChannel();
        (WorkflowRunner runner, FileSystemJsonCheckpointStore store) = CreateRunner(chat, pendingStore, channel);

        using (store)
        {
            WorkflowRunOutcome outcome = await runner.StartAsync(s_trigger);

            Assert.Equal(RunStatusKind.WaitingForHuman, outcome.Status);
            PendingDecision pending = outcome.Pending!;
            Assert.Equal(LeaseReviewWorkflow.Name, pending.WorkflowName);
            Assert.Equal(LeaseReviewWorkflow.DecisionPortId, pending.PortId);
            Assert.Equal(LeaseReviewWorkflow.CaseType, pending.Request.CaseType);
            Assert.Equal("PA", pending.Request.Attributes!["state"]);

            // The generic decision surface is derived from the review.
            Assert.Equal("High", pending.Request.Assessment.RiskLevel);
            Assert.Contains("Return", pending.Request.Assessment.Recommendation);
            Assert.Contains("2 required before execution", pending.Request.Assessment.Rationale);

            // The full review survives the round trip through the pending store on disk.
            PendingDecision persisted = (await pendingStore.GetAsync(pending.RequestId))!;
            Assert.True(persisted.Request.TryGetDetail(out LeaseReview? review));
            Assert.Equal(5, review.CurativeItems.Count);
            Assert.Equal(2, review.BlockingCurative.Count());
            Assert.Equal(4, review.NonStandardProvisions.Count());
            Assert.Equal("18% of gross proceeds", review.KeyTerms.RoyaltyRate);

            // The analyst was asked to fetch everything before writing.
            string prompt = string.Join('\n', chat.Calls.Single().Select(m => m.Text));
            Assert.Contains("L-2026-0142", prompt);
            Assert.Contains("title records", prompt);
        }
    }

    [Fact]
    public async Task Approved_lease_is_recorded_with_curative_tasks_after_a_process_restart()
    {
        var pendingStore = new FilePendingDecisionStore(Path.Combine(_dir, "pending"));
        var channel = new RecordingDecisionChannel();

        string requestId;
        DecisionRequest request;
        {
            var chat = new ScriptedChatClient(LeaseReviewJson);
            (WorkflowRunner runner, FileSystemJsonCheckpointStore store) = CreateRunner(chat, pendingStore, channel);
            using (store)
            {
                WorkflowRunOutcome outcome = await runner.StartAsync(s_trigger);
                requestId = outcome.Pending!.RequestId;
                request = outcome.Pending.Request;
            }
        }

        {
            var chat = new ScriptedChatClient(RecordReportJson);
            (WorkflowRunner runner, FileSystemJsonCheckpointStore store) = CreateRunner(chat, pendingStore, channel);
            using (store)
            {
                var decision = new Decision(request, DecisionOutcome.Approved, "Land Manager (aaaa-1111)", "Approve; open curative now, negotiate depth clause separately.", DateTimeOffset.UtcNow);
                WorkflowRunOutcome outcome = await runner.ResumeAsync(requestId, decision);

                Assert.Equal(RunStatusKind.Completed, outcome.Status);
                Assert.Equal(DecisionOutcome.Approved, outcome.Result!.Outcome);
                Assert.Contains("5 curative task(s)", outcome.Result.Summary);
                Assert.Contains("CUR-0001", outcome.Result.ActionTaken);

                // The operator was told exactly what to record and which items to open.
                string prompt = string.Join('\n', chat.Calls.Single().Select(m => m.Text));
                Assert.Contains("ApprovedForExecution", prompt);
                Assert.Contains("Affidavit of Heirship", prompt);
                Assert.Contains("Subordination Agreement", prompt);
                Assert.Contains("open curative now", prompt);

                Assert.Single(channel.Completed);
                Assert.Null(await pendingStore.GetAsync(requestId));
            }
        }
    }

    [Fact]
    public async Task Returned_lease_is_recorded_without_tasks_or_status_change()
    {
        var chat = new ScriptedChatClient(LeaseReviewJson, ReturnReportJson);
        (WorkflowRunner runner, FileSystemJsonCheckpointStore store) = CreateRunner(chat, new InMemoryPendingDecisionStore(), new RecordingDecisionChannel());

        using (store)
        {
            WorkflowRunOutcome started = await runner.StartAsync(s_trigger);
            var decision = new Decision(started.Pending!.Request, DecisionOutcome.Rejected, "Land Manager (aaaa-1111)", "Send back: strike favored nations, all depths.", DateTimeOffset.UtcNow);

            WorkflowRunOutcome outcome = await runner.ResumeAsync(started.Pending.RequestId, decision);

            Assert.Equal(RunStatusKind.Completed, outcome.Status);
            Assert.Equal(DecisionOutcome.Rejected, outcome.Result!.Outcome);
            Assert.StartsWith("Returned for revision", outcome.Result.Summary);

            string prompt = string.Join('\n', chat.Calls[1].Select(m => m.Text));
            Assert.Contains("ReturnedForRevision", prompt);
            Assert.Contains("do not create curative tasks", prompt);
            Assert.Contains("strike favored nations", prompt);
        }
    }

    [Fact]
    public void Lease_card_shows_terms_provisions_curative_and_both_actions()
    {
        var chat = new ScriptedChatClient();
        _ = chat;
        LeaseReview review = System.Text.Json.JsonSerializer.Deserialize<LeaseReview>(LeaseReviewJson, WorkflowJson.CheckpointOptions)!;
        DecisionRequest request = DecisionRequest.Create("L-2026-0142", LeaseReviewWorkflow.CaseType, ReviewLeaseExecutor.ToAssessment(review), review, s_trigger.Attributes);
        var pending = new PendingDecision("req-7", LeaseReviewWorkflow.Name, "s", "c", LeaseReviewWorkflow.DecisionPortId, request, DateTimeOffset.UtcNow, null);

        string json = DecisionCard.BuildRequestCard(pending);

        Assert.Contains("Lease sign-off: L-2026-0142", json);
        Assert.Contains("18% of gross proceeds", json);
        Assert.Contains("Heirship", json);
        Assert.Contains("Affidavit of Heirship", json);
        Assert.Contains("Favored nations", json);
        Assert.Contains("Approve for execution", json);
        Assert.Contains("Return for revision", json);
        Assert.Contains("req-7", json);
        Assert.True(json.Length < 28 * 1024, "Teams rejects cards over 28 KB");
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_dir))
            {
                Directory.Delete(_dir, recursive: true);
            }
        }
        catch
        {
            // best effort cleanup
        }
    }
}
